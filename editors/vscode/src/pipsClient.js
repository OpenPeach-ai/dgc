import {createConnectorInputs,mountConnectorInputs,readConnectorInputs,mountConnectorSummary} from './pipsConnectorForm.js';
import {connectorDraft,connectorDraftsPage,connectorCall,connectorInspection,actionStatus,calendarAccounts,calendarDraft,calendarDetails,extendedCalendar,sendAccounts,messageDraft,messageReview,messageHistory,messageStates,emailDraft,emailDraftsPage} from './pipsMessageReviews.js';
import './pips.css';
import {accountChoices,accountReadPlan,appLabels,appReadNotices,appReadWords,extraReadTools,combineReadPlans} from './pipsAppPicker.js';
import './pipsTranscript.css';
import '../media/breakdown.js'; // window.DgcBreakdown: the context window part by part, as main DGC and ChatDGC draw it
import '../media/voicebar.js';  // window.DgcVoiceBar: the box while you dictate, as main DGC and ChatDGC show it
import '../media/voicebar.css';
import '../media/readaloud.js'; // window.DgcReadAloud: a reply read aloud, as main DGC and ChatDGC play it
import '../media/voicemode.js'; // window.DgcVoiceMode: a spoken conversation, as ChatDGC has it
import '../media/texthistory.js'; // window.DgcTextHistory: undo and redo for the chat box, as main DGC and ChatDGC have them
import {messageMarkup,replyParts,executionCardMarkup,transcriptIcon} from './pipsTranscript.js';
import {runPostsPage,mergePosts,postMarkup,postShort,postStatus,timeline,shortReply,routineTitle as postRoutineTitle} from './pipRunPosts.js';
import {mountSetupCards} from './pipSetupCards.js';
import {mountDigestBar} from './pipDigestBar.js';
import {mountHomePips} from './pipHomeStrip.js';
import {appLinksPage,appLinkResult,shownAppLinks,appLinkMarkup,allowCardMarkup,calendarCardMarkup} from './pipAppLinks.js';
import {pluginsPage,pluginResult,shownPluginCards,pluginForServer,installedForServer,pluginCardMarkup,pluginActionMarkup,pluginsPageMarkup,pluginUsesPage,pluginUsesMarkup,argumentValues,editedArguments,PLUGIN_LEVELS} from './pipPlugins.js';
import {attentionPage,attentionMarkup,attentionNavigation,cardSelector} from './pipAttention.js';
import {notesPage,notesMarkup,keptMarkup} from './pipNotes.js';
import {workingNotesPage,dailyLogPage,workingNotesMarkup,dailyLogMarkup,learnCardMarkup,learnRequest} from './pipWorkingNotes.js';
import {carefulPage,carefulMarkup,carefulWords,sendsWords} from './pipCareful.js';
import {loginsMarkup,loginFormMarkup,readLoginForm,loginFormProblem,clearLoginForm} from './pipLogins.js';
import {pipLogins,pipLogin} from './pipsModel.js';
import {livePlan,livePlanFromText,livePip} from './pipsModel.js';
import {cardNumber} from './pipCards.js';
import {eyesMarkup,eyesNotice} from './pipEyes.js';
import {levelPage,levelMarkup,levelNotice} from './pipLevels.js';
import {borrowsPage,borrowResult,shownBorrows,borrowActive,borrowMarkup} from './pipBorrow.js';
import {routinesPage,routineDraft,routineFromDraft,shownRoutineCards,routineCardMarkup,routinesMarkup,routineFormMarkup,shortDate} from './pipRoutines.js';
import {profile,tintStyles,sharedPage,computersPage,appsPage,headMarkup,pageTabsMarkup,infoMarkup,instructionsMarkup,characterMarkup,linksMarkup,mediaMarkup,filesMarkup,computersMarkup,appsMarkup as appsSettingsMarkup,BODIES,COLORS} from './pipProfile.js';
import {pipSetup,pipSetups,pipSetupPrompt,pipSetupResolution,appReadPlan,webReadPlan,webReadLabel,SEVERITIES,pipNotifySettings,pipOutcomes,githubReadPlan,githubReadLabel,pipsKeepRunning,pipsDesktopNotifications,pipUsage,pipFeedback,actionGrants,actionGrant,pipComputer,pipComputerDesktop,pipComputerAction,pipComputerView,pipComputerFrame,pipComputerFrames,pipComputerFiles,pipComputerPointer,pipEyes} from './pipsModel.js';
import '../media/pips/plush.js';
import {ownAppsPage,ownAppForServer,ownAppsMarkup,isOwnApp,ownAppDecision,ownAppDecisionNotice,ownAppDecisionMarkup} from './pipOwnApps.js';
import {PIP_STATEMENT_NOTICE,pipStatementCandidate,pipStatement,pipStatementsPage,pipStatementDraft,pipStatementResult} from './pipsModel.js';
import {COMMAND_OUTCOME_NOTICE,commandReceipt,commandReceiptsPage,commandRecording,commandOutcomeEntry,commandOutcomeSummary} from './pipsModel.js';
import {outcomeWords,reviewStatusWords,commandLine,executionContextWords,notificationWords,eventWords} from './pipsModel.js';
import {esc,record,active,statusLabel,personalStatusLabel,errorText,report,runner,context,presentation,requestBroker,execution,activityPage,activityLabel,scheduleLabel,scheduleFromDraft,approvalStatus,approvalsPage,pipTypes,pipType,pendingReviews,messagesPage,chatContinuity,pipModels,modelChoice,modelLabel,modelValue,subscriptionUsage,runCheckpoint,checkpointsPage,checkpointBaseline,executionPip,pulsePip,pulsePlan,pulsePlanEqual,pulsePlanFromCommands,pulseRunPins,pulseVerificationPin,pulseVerificationReceipt,pulseCommandLabel,pulseProgress,handoffAction,handoffRecord,handoffsPage,handoffPin,executionResult,executionReview,patchArtifactSource,documentationPip,documentationDraft,savedProposal,ADAPTATION_MODES,adaptationPolicy,adaptationLabel,adaptationsPage,EVENT_TRIGGER_NAMES,commitPathRules,commitPathObservation,eventTrigger,eventTriggerLabel,eventTriggerFromDraft,eventRunPin,draftAutomationPin,sourcePolicy,sourcePolicyLabel,sourceSnapshot,sourcePin,sourceResult,sourceRules,sourceWithExcludes,sourceExcludeError,sourceLeftOut,leftOutLines,sourceCheck,sizeText,MAX_SOURCE_EXCLUDES,SESSION_STATEMENT_NOTICE,sessionGeneration,sessionSourceSelection,sessionStatement,sessionStatementsPage,workspaceSessionsPage,pipNotification,notificationsPage,notificationNavigation,PIP_MEMORY_NOTICE,pipExceptionSourceEqual,pipExceptionCandidate,pipMemory,pipMemoriesPage,pipMemoryPin,SPECIALIST_ROLES,specialistGrant,specialistPolicy,specialistReceipt,lifecycleRevision,archivalResult} from './pipsModel.js';


// The main DGC chat mounts one instance in a ShadowRoot; the editor document is a fallback.
export const PIPS_API_VERSION=9;
export function mountPips(options) {
  const nativeDocument=window.document,root=options.root||nativeDocument;
  const embedded=root!==nativeDocument,owner=root.ownerDocument||nativeDocument,disposers=[];
  const remoteHost=options.host==='remote';
  let disposed=false,motionPaused=false;
  // A notice says what just happened, then goes: longer ones stay long enough to read. Errors stay.
  let noticeShown='',noticeTimer=0;
  function noticeFades(){
    if(!S.notice){noticeShown='';return;}
    if(S.notice===noticeShown)return;
    noticeShown=S.notice;window.clearTimeout(noticeTimer);
    const shown=S.notice;noticeTimer=window.setTimeout(()=>{if(!disposed&&S.notice===shown){S.notice='';noticeShown='';render();}},Math.min(15000,4000+60*shown.length));
  }
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
const S = {posts:[],postsCursor:null,postsPip:'',postsLoaded:false,postsLoading:false,postsError:'',apiVersion:0,connected:false,supported:false,enabled:false,epoch:0,workspace:null,jobs:[],selected:'',pip:null,runs:[],run:null,runId:'',context:null,runner:null,tab:'chat',versions:[],cursor:null,historyLoaded:false,create:false,loading:false,refreshing:false,busy:false,error:'',notice:'',review:null,visible:true,generation:null,activity:null,activityLoading:false,activityError:'',approvals:[],approvalCursor:null,approvalsLoaded:false,approvalsLoading:false,approvalsError:'',scheduleDirty:false,scheduleDraftVersion:null};
S.connectorDrafts=[];S.connectorDraftError="";let connectorDraftSeq=0;
// Dictation: 'idle' | 'starting' | 'recording' | 'writing'. The voice bar's controller keeps the waveform; it looks in
// this box's root (a shadow root in the side bar) for the bar each render draws.
S.mic='idle';const voiceBar=window.DgcVoiceBar?window.DgcVoiceBar.create('pips',root):null;
// Read aloud: the speaker under a Pip's reply. The page is redrawn often: each new speaker shows what's being read.
const reader=window.DgcReadAloud?window.DgcReadAloud.create({post:m=>vscode.postMessage({...m,from:'pips'}),within:root}):null;
reader?.onError((text,kind)=>{if(kind==='info')S.notice=text;else S.error=text;render();});
// Voice mode (media/voicemode.js): a spoken conversation with the Pip. Its bar draws itself into each render.
const talkBar=window.DgcVoiceBar?window.DgcVoiceBar.create('pips-talk',root):null;
const voiceMode=talkBar&&reader&&window.DgcVoiceMode?window.DgcVoiceMode.create({bar:talkBar,reader,
  post:m=>vscode.postMessage({...m,from:'pips'}),
  deliver:text=>chatEdit(()=>{micCaret=null;draft.chatText='';dictatedToPip(text,true);}),
  messages:()=>S.messages,
  show:()=>render(),
  notify:(text,kind)=>{if(kind==='info')S.notice=text;else S.error=text;render();}}):null;
// Undo and redo for the chat box (media/texthistory.js). The page is redrawn whenever anything changes, and every redraw
// is a new <textarea> with an empty history of its own: Cmd/Ctrl+Z in a Pip's box did nothing once a reply streamed in, or
// once the first word swapped voice mode for Send. The history lives outside the element, and the box's own edits --
// what was dictated, a message sent or given back, a choice added -- are steps of it.
const chatHistory=window.DgcTextHistory?window.DgcTextHistory.create({box:()=>$('chatText'),changed:()=>{const box=$('chatText');if(!box)return;draft.chatText=box.value;if(S.selected)chatDrafts.set(S.selected,draft.chatText);rememberView();render();fitChatInput();}}):null;
const chatEdit=change=>chatHistory?chatHistory.record(change):change();
function micShow(next,action=''){S.mic=['starting','recording','writing'].includes(next)?next:'idle';voiceBar?.state(S.mic,action);}
function micCancel(){micShow('idle');render();vscode.postMessage({type:'micCancel',from:'pips'});$('chatText')?.focus();}
/** What was said, at the caret of the Pip's box, spaced from its neighbours; then sent, when Send stopped it. */
// Where the caret was when the microphone was pressed: the box is redrawn while it records, and a redrawn box's
// caret is at its start.
let micCaret=null;
function dictatedToPip(text,send){
  const whole=draft.chatText||'',[start,end]=micCaret&&micCaret[1]<=whole.length?micCaret:[whole.length,whole.length];micCaret=null;
  const before=whole.slice(0,start),after=whole.slice(end);
  const piece=(before&&!/\s$/.test(before)?' ':'')+text+(after&&!/^\s/.test(after)?' ':'');
  chatEdit(()=>{draft.chatText=(before+piece+after).slice(0,4000);render();});
  const again=$('chatText');if(again){again.focus();const at=Math.min(draft.chatText.length,start+piece.length);again.setSelectionRange(at,at);}
  fitChatInput();
  if(send)void sendChat();
}
S.workspaces=[];S.currentWorkspaceId=null;S.folderOpen=true;S.projectEmpty=false;S.switching=false;S.showArchived=false;S.emailDrafts=[];S.emailDraftError="";S.calendarDrafts=[];S.calendarDraftError="";let emailDraftSeq=0,calendarDraftSeq=0;
S.composerPanel='';S.chatControls=null;S.continuity=null;
const chatPreferences=new Map();
const chatActivities=new Map();
let setupEditing=false,setupRows=[],setupLoading=false,setupError='',setupSeq=0,setupDetailSeq=0;
// The browser may still name a zone by its old name (Chromium says Asia/Calcutta); the current name is
// what every runner has installed (Ubuntu 24.04+ keeps old names in tzdata-legacy).
const OLD_ZONES={'Asia/Calcutta':'Asia/Kolkata','Asia/Saigon':'Asia/Ho_Chi_Minh','Asia/Katmandu':'Asia/Kathmandu','Asia/Rangoon':'Asia/Yangon','Asia/Dacca':'Asia/Dhaka','Europe/Kiev':'Europe/Kyiv','America/Buenos_Aires':'America/Argentina/Buenos_Aires','America/Godthab':'America/Nuuk','Atlantic/Faeroe':'Atlantic/Faroe','Pacific/Truk':'Pacific/Chuuk'};
const browserZone=Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const defaultZone=OLD_ZONES[browserZone]||browserZone;
S.sourceDirty=false;S.sourceDraftVersion=null;S.adaptations=[];S.adaptationCursor=null;S.adaptationsLoaded=false;S.adaptationsLoading=false;S.adaptationsError='';S.adaptationDirty=false;S.adaptationDraftVersion=null;S.handoffs=[];S.handoffCursor=null;S.handoffsLoaded=false;S.handoffsLoading=false;S.handoffsError='';S.handoffDraft=null;S.executionCapability=null;S.executionLoading=false;S.executionError='';S.checkpoints=[];S.checkpointCursor=null;S.checkpointsLoaded=false;S.checkpointsLoading=false;S.checkpointsError='';S.types=[];S.createStep='type';S.createType='';S.overview=true;S.messages=[];S.messageCursor=null;S.messagesLoaded=false;S.messagesLoading=false;S.messagesError='';S.chatActiveRun=null;S.omitted=0;S.models=[];S.defaultModel='';S.subscriptions=[];S.defaultEngine=null;S.modelsError='';S.modelsLoading=false;S.modelDirty=false;S.stream=null;
const creationDrafts=new Map(),avatarIds=new Map(),chatDrafts=new Map(),chatRequests=new Map();let avatarSequence=0,avatarObserver=null,characterCleanup=null,messageSeq=0,streamSeq=0,streamLoading=false,selectionGeneration=0;
let savedView=options.getState?.(),restoreView=true,navigationPending=!!options.navigation;
let postsSeq=0;
// Ask DGC to fix, once per run: kept with the view, as the Work chat keeps the prompt in its transcript.
const askedRuns=new Set(Array.isArray(savedView?.asked)?savedView.asked.filter(r=>typeof r==='string'&&/^run_[0-9a-f]{32}$/.test(r)).slice(-100):[]);
// Show all, opened on a run's result or a routine's reply (by run or message id): for this view only.
const shownInFull=new Set();
S.sidebarPinned=savedView?.sidebar_pinned===true;
function rememberView(){savedView={workspace_id:S.workspace?.id,scope_tab:S.workspace?scopeTab():undefined,selected:S.selected,tab:S.tab,overview:S.overview,sidebar_pinned:S.sidebarPinned,drafts:Object.fromEntries([...chatDrafts].slice(-20)),asked:[...askedRuns].slice(-100)};options.setState?.(savedView);}
const characterStyles=document.createElement('style');characterStyles.id='pips-plush-styles';characterStyles.textContent=window.PipConcepts.plush.styles;document.head.append(characterStyles);
let outcomeSessions=[],outcomeSessionsCursor='',outcomeSessionsMore=false,outcomeSessionsLoaded=false,outcomeSessionsLoading=false,outcomeSessionsError='',outcomeHistory=[],outcomeCursor=null,outcomeLoaded=false,outcomeLoading=false,outcomeError='',outcomeInspection=null,outcomeInspecting=false,outcomeSessionSeq=0,outcomeSeq=0,outcomeInspectSeq=0,outcomeReviewSeq=0,outcomeRetry=null;
let notifications=null,notificationItems=[],notificationLoading=false,notificationError='',notificationSeq=0,notificationMark='';
let memories=[],memoryCursor=null,memoryLoaded=false,memoryLoading=false,memoryError='',memorySeq=0,memorySourceSeq=0;
let statementRows=[],statementPage=null,statementLoaded=false,statementLoading=false,statementError='',statementSeq=0,statementAnchorSeq=0,statementInspecting=false,statementRetry=null;
let commandReceipts=[],commandCursor=null,commandMore=false,commandTotal=0,commandLoaded=false,commandLoading=false,commandError='',commandSession='',commandSeq=0,commandDetailSeq=0;
let pulseCommands=[{argv:[''],cwd:'.'}],commitRules=[{kind:'exact',path:''}];
// The Source section's Excluded folders (safe_source_v2, API 50), its size check and one run's left-out record.
let sourceExcludeList=[],sourceExcludeProblem='',sourceCheckState={pip:'',value:null,loading:false,error:''},runSourceState={run:'',value:null,error:''};
const draft = {sourceExcludeInput:'',noteAdd:'',workingNotesText:'',pipLearnText:'',newPipName:'',newPipCharacter:'scout',quickKind:'manual',quickTime:'08:30',quickHours:'4',quickZone:defaultZone,feedbackNote:'',webReads:'',chatModelSearch:'',setupTask:'',verificationEnabled:false,pulseMode:'tests',liveCommands:'',statementKind:'fact',statementTitle:'',statementText:'',statementReason:'',statementExpiry:'',statementSource:'',specialistExplorer:false,specialistCritic:false,specialistWorker:false,specialistCalls:'1',memoryExpiry:'',outcomeSession:'',outcomeSourceKind:'commit',outcomeSourceValue:'',outcomeTitle:'',outcomeText:'',sourceMode:'committed_only',sourceReason:'',triggerContext:false,triggerFinding:false,triggerCommit:false,triggerSession:false,triggerPaths:false,triggerMinutes:'5',adaptationMode:'suggest_changes',adaptationName:false,adaptationSource:false,adaptationReason:'',handoffText:'',handoffTarget:'',handoffTask:'',handoffPaths:'',handoffTests:'[]',createModel:'default',pipModel:'default',modelReason:'',findingReviewReason:'',chatText:'',scheduleType:'manual',scheduleAt:'',scheduleCron:'0 9 * * 1-5',scheduleMinutes:'60',scheduleTime:'09:00',scheduleZone:defaultZone,scheduleReason:'',name:'',goal:'',source_ref:'HEAD',revisionGoal:'',revisionReason:'',contextKind:'decision',contextTitle:'',contextContent:''};
let adaptationSeq=0,handoffSeq=0,handoffDetailSeq=0,checkpointSeq=0,refreshSeq=0,selectionSeq=0,detailSeq=0,historySeq=0,activitySeq=0,approvalSeq=0,polling=false,dialogReturn=null,lastMarkup='';
const send = (type,args={}) => broker.request({type,...args});
const usable = () => S.connected && S.supported && S.enabled;
const archived=()=>S.pip?.status==='archived';
const canLifecycle=()=>S.apiVersion>=16&&lifecycleRevision(S.pip)!==null&&lifecycleRevision(S.pip)<Number.MAX_SAFE_INTEGER;
const scope = () => `${S.epoch}:${S.workspace?.id || ''}:${S.selected}:${selectionGeneration}`;
const date = value => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : 'Time unavailable';
const button = (id,text,disabled=false,kind='') => `<button type="button" id="${id}" class="${kind}"${disabled?' disabled':''}>${esc(text)}</button>`;
function avatar(state='idle',type={id:'rook',character_index:4,name:'Rook'},key='welcome',tint='') {
  if(!avatarIds.has(key))avatarIds.set(key,++avatarSequence);
  const id=`editor-pip-${avatarIds.get(key)}`;
  return `<span class="avatar" data-avatar-key="${esc(key)}" data-character="${esc(type?.id||'unsupported')}" data-pose="${esc(state)}"${tint?` data-tint="${esc(tint)}"`:''} aria-hidden="true">${type?window.PipConcepts.plush.markup({index:type.character_index,name:type.name},state,id,{includeStyles:false}):'<span class="unknown-avatar">?</span>'}</span>`;
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
  return entries.length ? entries.map(e=>`<article class="entry"><span class="badge">${e.kind==='session_outcome'?'Session statement':e.kind==='execution'?'Accepted run outcome':e.kind==='finding'?'Finding':esc(e.kind[0].toUpperCase()+e.kind.slice(1))}</span><h3>${esc(e.title)}</h3><div class="goal">${esc(e.kind==='session_outcome'?e.provenance.proposal.statement:e.kind==='execution'?executionContextWords(e.provenance):e.content)}</div><p class="muted">${e.kind==='session_outcome'?'You wrote this. It wasn’t checked against anything that ran.':e.kind==='execution'?'What the run did when you accepted it. It doesn’t prove the code is correct now.':e.kind==='finding'?'The quoted code was checked; the model’s conclusion wasn’t.':'Added by you.'} ${e.kind==='command'?'A note only: it doesn’t let any Pip run this command.':''}</p>${e.kind==='finding'&&e.provenance.schema_version===2?`<dl class="meta">${pinnedSourceMarkup(e.provenance)}</dl>${pinnedSourceNotice(e.provenance)}`:''}${e.kind==='session_outcome'?sessionStatementDetails(e.provenance.proposal,e.provenance.proposal_digest):''}${e.kind==='execution'?`<details><summary>Saved record</summary><div class="goal">${esc(e.content)}</div></details>`:''}${e.provenance?.run_id?`<small>Version ${esc(e.provenance.job_version)} · ${esc(e.provenance.model)}</small>`:''}${archivable?`<div class="actions"><button type="button" data-archive="${esc(e.id)}"${S.busy||!usable()?' disabled':''}>Archive record</button></div>`:''}</article>`).join('') : '<p class="muted">No context yet.</p>';
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
  S.notice=value.on?(value.while_logged_out?'Pips keep running: they start when you log in, restart if they fail, and run while you are logged out.':'Pips keep running: they start when you log in and restart if they fail.'):'Pips no longer start on their own. They keep running now until you stop them.';}
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
  S.notice=value.on?'Desktop notifications on: you hear about a new alert or review, even with the editor closed.':'Desktop notifications off. The editor still tells you while it is open.';}
 catch(error){if(token===scope()){desktopState.error=errorText(error);setError(error);}}
 finally{if(token===scope()){S.busy=false;render();}}
}
function desktopNotificationsMarkup(){
 if(remoteHost||S.apiVersion<41||!S.connected||!S.enabled)return '';
 if(!desktopState.asked&&usable())void loadDesktopNotifications();
 const d=desktopState.value;
 if(!d)return desktopState.error?`<p class="muted keep-running-note">${esc(desktopState.error)}</p>`:'';
 const note=!d.available?'This computer can’t show desktop notifications. The editor still tells you while it is open.'
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
 const note=k.on?(k.while_logged_out?'Starts when you log in and after a restart, restarts if it fails, and runs while you are logged out.':'Starts when you log in and after a restart, and restarts if it fails.'):'Off: Pips run only after you start them. Turn this on so a schedule still runs after a restart.';
 return `<label class="keep-running"><input type="checkbox" id="keep-running"${k.on?' checked':''}${S.busy||!usable()?' disabled':''}> Keep Pips running</label><p class="muted keep-running-note">${esc(note)}</p>`;
}
function runnerMarkup() {
  const r=S.runner,paused=r?.paused;
  const state=`<span class="runner-status"><i class="status-dot${r?.online?' online':''}" aria-hidden="true"></i>${!S.connected?'Not connected to DGC':!S.enabled?'Pips are off':r?(paused?'Pips stopped':r.online?'Pips running':'Pips not running'):'Can’t tell if Pips are running'}</span>`;
  const start=remoteHost?'':`${r&&!r.online&&!paused?button('start-runner','Start Pips',S.busy||!usable()):''}${paused?button('resume-runner','Resume Pips…',S.busy||!usable()):''}`;
  const counts=r?`<span class="muted">${r.counts.queued} waiting to start · ${r.counts.running} working</span>`:'';
  const controls=`${button('refresh','Refresh',!usable())}${button('stop-all','Stop all Pips…',!usable()||S.busy,'danger')}`;
  return `<div class="runner compact-runner">${state}${start}<details class="runner-controls" data-details="runner-controls"><summary id="runner-controls-toggle">Controls</summary><div class="runner-menu">${counts}${keepRunningMarkup()}${desktopNotificationsMarkup()}<div class="actions">${controls}</div><p class="muted">Stop all pauses every Pip on this computer and stops what they’re doing. To undo it, resume Pips here, then resume each Pip.</p>${remoteHost?'<p class="muted">To start or resume Pips, run <code>dgc pips resume</code> and <code>dgc pips serve</code> on that computer. From here you can’t turn Pips on or change how they run.</p>':button('disable','Turn off Pips…',S.busy||!usable())}</div></details></div>${r?.error?errorMarkup(r.error.message):''}`;
}
function welcome() {
  if(remoteHost&&!S.connected)return `<div class="empty">${avatar('offline')}<h2>Computer disconnected</h2><p class="muted">Reconnect the approved computer to read current Pips and send commands over the encrypted connection.</p>${button('reconnect','Check connection')}</div>`;
  if(remoteHost&&!S.enabled)return '<div class="empty"><h2>Turn on Pips on that computer</h2><p class="muted">From here you can’t turn Pips on, choose a folder or start them.</p><code>dgc remote connect --pips</code></div>';
  if (!S.connected) return `<div class="empty">${avatar('offline')}<h2>Connect to local DGC</h2><p class="muted">Pips uses the DGC process in this editor. No web account is needed.</p>${button('reconnect','Reconnect')}</div>`;
  // An API new enough for Pips that still says unsupported is the platform, not the version.
  if (!S.supported && S.apiVersion >= 41) return `<div class="empty"><h2>On Windows, Pips run in WSL</h2><p class="muted">Install DGC inside WSL and open your folder in the editor connected to WSL: Pips work there as on Linux. Everything else in DGC works here.</p></div>`;
  if (!S.supported) return `<div class="empty"><h2>Update DGC to use Pips</h2><p class="muted">This DGC is too old for Pips. Update it, then reconnect.</p>${button('reconnect','Reconnect')}</div>`;
  if (!S.enabled) return `<div class="empty">${avatar()}<h2>Meet your Pips</h2><p>Little helpers that work for you on this computer: they look things up, keep an eye on what you care about, and draft what you need.</p><p class="muted">Nothing is sent or changed without your OK. They use your DGC model.</p>${button('enable','Turn on Pips',S.busy,'primary')}</div>`;
  if (S.loading) return '<p role="status">Loading the current workspace…</p>';
  if (!S.types.length || !S.workspace) return `<div class="empty"><h2>Pips didn’t load</h2><p class="muted">Reconnect to try again.</p>${button('reconnect','Reconnect')}</div>`;
  return '';
}
function createMarkup() {
  if(S.workspace?.kind==='personal'&&S.createStep!=='describe')return `<section class="setup-compose"><h2>Your personal Pip</h2><p class="muted">Available across your projects on this computer. No project files or app access are inherited.</p><form id="create-form" class="form"><label for="personal-character">Character</label><select id="personal-character">${S.types.filter(t=>t.available).map(t=>`<option value="${esc(t.id)}"${t.id===S.createType?' selected':''}>${esc(t.name)}</option>`).join('')}</select>${field('name','Name')}${field('goal','What would you like help with?',true)}${modelPicker('createModel','Model',draft.createModel,S.workspace?.kind==='personal')}<p class="muted">Start a private conversation. App access must be separately supported and reviewed before email or calendar jobs can run.</p><button type="submit" class="primary">Create personal Pip</button>${button('cancel-create','Cancel',S.busy)}</form></section>`;

  if(S.workspace?.kind==='personal'&&S.createStep==='describe')return `<section class="setup-compose"><p class="step">Personal · across your projects</p><h2>What would you like a hand with?</h2>${startersMarkup('personal')}${importMarkup()}<p class="muted">Describe the task in your own words. DGC will prepare a setup card for your review.</p><form id="setup-prompt-form" class="form">${field('setupTask','Describe the job',true)}<p class="muted">For example: Help me plan my week every Sunday at 6 pm. Ask me what to include.</p>${options.onSetupPrompt&&!remoteHost?'<button type="submit" class="primary">Describe to DGC</button>':'<p>Describe the task in the main DGC chat.</p>'}</form><p class="muted">Private to this DGC profile. No project files or connected apps are included automatically.</p><div class="actions">${button('advanced-create','Choose a Pip myself',S.busy)}${button('cancel-create','Cancel',S.busy)}</div></section>`;
  if(S.createStep==='describe')return `<section class="setup-compose" aria-labelledby="setup-compose-title"><p class="step">Start with the job</p><h2 id="setup-compose-title">What should your Pip look after?</h2>${startersMarkup('project')}${importMarkup()}<p class="muted">Tell DGC the project, the task and when to do it. You check it on one card before anything starts.</p><form id="setup-prompt-form" class="form">${field('setupTask','Describe the job',true)}<p class="muted">For example: Review committed changes in this project daily at 11:00 in Asia/Kolkata. Also run once today.</p>${options.onSetupPrompt&&!remoteHost?'<button type="submit" class="primary"'+(S.busy||!usable()?' disabled':'')+'>Describe to DGC</button>':'<p class="notice">Describe it in the DGC chat on your computer. This view can’t send it there.</p>'}</form><p class="muted">Project: ${esc(S.workspace.name)}. DGC confirms the project folder with you. To check a running app, you approve its test commands separately.</p><div class="actions">${button('advanced-create','Advanced: choose a Pip',S.busy)}${button('cancel-create','Cancel',S.busy)}</div></section>`;

  if(S.createStep==='type')return `<section class="type-picker" aria-labelledby="type-picker-title"><p class="step">Step 1 of 2 · Choose your Pip</p><h2 id="type-picker-title">Who’s right for this job?</h2><p class="muted">Scout, Lens, Rook and Lock read committed code. Patch fixes files and Pulse runs tests, each in a private copy and only as you approve. Quill writes private documentation drafts. Chatting with any Pip never changes your files.</p>${S.types.length?`<div class="type-grid">${S.types.map(t=>`<article class="type-card${t.available?'':' planned'}" data-type-card="${esc(t.id)}">${avatar(t.available?'idle':'offline',t,`choose-${t.id}`)}<div class="type-copy"><h3>${esc(t.name)}<span class="badge">${t.available?(executionPip(t)?'You approve each run':documentationPip(t)?'Drafts only':'Reads only'):'Planned'}</span></h3><p class="type-role">${esc(t.role)}</p><p class="muted">${esc(t.description)}</p>${!t.available?`<p class="type-reason">${esc(t.unavailable_reason)}</p>`:''}</div><button type="button" data-pip-type="${esc(t.id)}"${!t.available||S.busy||!usable()?' disabled':''}>${t.available?`Choose ${esc(t.name)}`:'Not available yet'}</button></article>`).join('')}</div>`:'<p class="notice error">Pip types are unavailable. Reconnect to retry.</p>'}<div class="actions">${button('cancel-create','Cancel',S.busy)}</div></section>`;
  const type=S.types.find(t=>t.id===S.createType);
  if(!type?.available)return '<p class="notice error">This Pip type is unavailable. Go back and choose an available type.</p>';
  return `<form id="create-form" class="form"><p class="step">Step 2 of 2 · Configure the job</p><div class="create-hero">${avatar('idle',type,`configure-${type.id}`)}<div><h2>Your ${esc(type.name)}</h2><p class="muted">${esc(type.role)} · ${executionPip(type)?'You approve each run':documentationPip(type)?'Private drafts':'Reads only'}</p></div></div><p>${esc(type.description)}</p><p class="muted">It runs when you ask, in ${esc(S.workspace?.name || 'this project')}. ${pulsePip(type)?'It can’t run any commands yet. After you create it, you can give it a command plan and a schedule.':executionPip(type)?'It runs only on a handoff you approve, never on a schedule.':documentationPip(type)?(S.apiVersion>=20?'After you create it, you can give it a schedule or have it run on events. It doesn’t take handoffs.':'Update DGC to give Quill a schedule or run it on events. It doesn’t take handoffs.'):'After you create it, you can give it a schedule.'} It reads only committed code from the branch or commit you choose.</p>${field('name','Name')}${field('goal','What it does',true)}${field('source_ref','Branch or commit')}${modelPicker('createModel','Model',draft.createModel,S.workspace?.kind==='personal')}<p class="muted">Use HEAD, a branch name or a commit. Uncommitted edits aren’t included. ${executionPip(type)?'Chatting with it never changes files. You approve every fix or test run separately; creating it allows neither.':documentationPip(type)?'Quill writes drafts with the model and quotes the exact code it used. It never changes or publishes your files.':'All of these read the code the same way; the character you pick doesn’t give it more access.'}</p><div class="actions">${button('back-types','Back',S.busy)}<button class="primary" type="submit"${S.busy||!usable()?' disabled':''}>${executionPip(type)?'Review what it can do…':'Create Pip'}</button>${button('cancel-create','Cancel',S.busy)}</div></form>`;
}
async function finishCreate(result){
  if(!record(result.pip)||typeof result.pip.id!=='string'||result.pip.workspace_id!==S.workspace.id)throw new Error('Created Pip does not match this workspace.');
  creationDrafts.delete(S.createType);draft.name='';draft.goal='';draft.source_ref='HEAD';S.createType='';S.createStep='type';S.busy=false;await select(result.pip.id);await refresh(true);
}
function rememberCreationDraft(){if(S.createType)creationDrafts.set(S.createType,{name:draft.name,goal:draft.goal,source_ref:draft.source_ref,createModel:draft.createModel});}
// API 55 (pip_brain): a Personal Pip may run on the user's own Claude Code or Codex, listed when signed in here.
function subscriptionChoices(personal){return S.apiVersion>=55&&personal?S.subscriptions||[]:[];}
function defaultModelName(){return S.defaultEngine?S.defaultEngine.name:S.defaultModel;}
// The one plain line about usage, where a subscription is chosen: by name, or by following DGC's default.
function usageLine(value){const engine=value.startsWith('subscription:')?value.slice(13):value==='default'&&S.defaultEngine?.available?S.defaultEngine.engine:'';const name=engine?modelLabel({mode:'subscription',engine}):'';return name?subscriptionUsage(name):'';}
function modelPicker(id,label,value,personal=false) {
  const explicit=value.startsWith('model:')?value.slice(6):'',subs=subscriptionChoices(personal),usage=subs.length||value.startsWith('subscription:')?usageLine(value):'';
  const engine=value.startsWith('subscription:')?value.slice(13):'';
  return `<label for="${id}">${esc(label)}</label><select id="${id}" data-draft="${id}"><option value="default"${value==='default'?' selected':''}>Same as DGC${defaultModelName()?` · ${esc(defaultModelName())}`:''}</option>${explicit&&!S.models.some(m=>m.id===explicit)?`<option value="${esc(value)}" selected>${esc(explicit)} · not in current list</option>`:''}${S.models.map(m=>`<option value="model:${esc(m.id)}"${explicit===m.id?' selected':''}>${esc(m.name)}</option>`).join('')}${subs.length||engine?`<optgroup label="Your subscriptions">${engine&&!subs.some(x=>x.engine===engine)?`<option value="${esc(value)}" selected>${esc(modelLabel({mode:'subscription',engine}))} · not signed in here</option>`:''}${subs.map(x=>`<option value="subscription:${esc(x.engine)}"${engine===x.engine?' selected':''}>${esc(x.name)}</option>`).join('')}</optgroup>`:''}</select>${usage?`<p class="muted" data-usage-line>${esc(usage)}</p>`:''}${S.modelsLoading?'<p class="muted" role="status">Loading models…</p>':''}${S.modelsError?`<p class="muted">${esc(S.modelsError)} ${button('refresh-models','Try again',S.modelsLoading||!usable(),'link')}</p>`:`<p class="muted">Models from your DGC connection${subs.length?', and your own subscriptions':''}. ${button('refresh-models','Refresh list',S.modelsLoading||!usable(),'link')}</p>`}`;
}
async function loadModels(){
  if(!usable()||S.modelsLoading)return;const epoch=S.epoch;S.modelsLoading=true;S.modelsError='';render();
  try{const result=pipModels(await send('list_pip_models'));if(epoch!==S.epoch)return;S.models=result.models;S.defaultModel=result.default_model;S.subscriptions=result.subscriptions;S.defaultEngine=result.default_engine;S.modelsError=result.error?errorText(result.error):'';}
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
function composerIcon(name){const paths={shield:'<path d="M8 1.5 13 3.5v4c0 3-2 5-5 7-3-2-5-4-5-7v-4Z"/><path d="m6 8 1.3 1.3L10 6.5"/>',context:'<path d="M7 2a6 6 0 1 0 7 7H7Z"/><path d="M9 1.5V7h5.5A6 6 0 0 0 9 1.5Z"/>',up:'<path d="M8 14V2M3 7l5-5 5 5"/>',chevron:'<path d="m4 10 4-4 4 4"/>',stop:'<rect x="4" y="4" width="8" height="8" rx=".5"/>',image:'<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.8" r="1.1"/><path d="m2.5 11.5 3.5-3.5 2.5 2.5 2-2 3 3"/>',zap:'<path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8Z"/>',next:'<path d="m6 4 4 4-4 4"/>',mic:'<rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5"/><path d="M3 8a5 5 0 0 0 10 0M8 13v1.5"/>'};return `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${paths[name]||''}</svg>`;}
function continuityMarkup(){
 const c=S.continuity;if(!c)return `<p class="composer-scope">${esc(S.pip?.name||'This Pip')} saves a summary of this chat after its next reply.</p>`;
 return `<details class="chat-continuity"><summary>Chat memory${c.summarized_messages?' · '+c.summarized_messages+' messages summarized':''}</summary><p class="muted">${esc(c.notice)}</p><p class="muted">${c.strategy==='mechanical'?'A short summary. Some details may be left out; your messages are still saved.':c.strategy==='model'?`A summary ${S.pip?.name||'it'} keeps up to date.`:'It still sees every message; nothing needs summarizing yet.'}</p>${c.summary?`<pre>${esc(c.summary)}</pre>`:''}<p class="muted">Summarized by ${esc(c.provenance.model||'its model')}</p></details>`;
}
// The prompt box's model and context controls, as DGC's own: the chip names the model and its
// effort, its menu is the reasoning card (slider; the model list one click deeper), and the context
// chip shows how full the window is, with the same meter in its menu.
const EFFORT_NAME={off:'Off',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high'};
S.modelListOpen=false;S.composerNoteOpen=false;S.chatContext=null;let chatContextSeq=0;
function composerNote(text){
 const long=text.length>160;
 return `<p class="composer-note${long&&!S.composerNoteOpen?' clamped':''}">${esc(text)}</p>${long?`<button type="button" class="composer-more" data-composer-more aria-expanded="${S.composerNoteOpen}">${S.composerNoteOpen?'Show less':'Show more'}</button>`:''}`;
}
async function loadChatContext(){
 if(remoteHost||S.apiVersion<44||!personalPip()||!usable()||!S.chatControls)return;
 const token=scope(),pip=S.selected,sequence=++chatContextSeq,size=chosenChatOptions().context_size;
 try{const v=await send('get_pip_chat_context',{pip_id:pip,context_size:size});if(token!==scope()||S.selected!==pip||sequence!==chatContextSeq)return;
  if(!record(v)||v.pip_id!==pip||v.context_size!==size||![v.used_tokens,v.recent_messages,v.summarized_messages].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('bad context');
  // Part by part (a DGC from before has none): drawn as text only, so a malformed one just isn't shown.
  const b=v.breakdown,parts=record(b)&&b.window===size&&Array.isArray(b.categories)&&b.categories.length<=32&&b.categories.every(c=>record(c)&&typeof c.id==='string'&&typeof c.label==='string'&&Number.isSafeInteger(c.tokens))?b:null;
  S.chatContext={...v,breakdown:parts};render();}
 catch{if(token===scope()&&sequence===chatContextSeq){S.chatContext=null;render();}}
}
function chatControlsMarkup(canSend,busy){
 // Dictating: the bottom row is the voice bar (media/voicebar.js), which draws itself into whatever is rendered here.
 if(voiceMode?.active)return `<div class="composer-controls pip-voice">${talkBar.markup('conversation')}</div>`;
 if(S.mic!=='idle')return `<div class="composer-controls pip-voice">${voiceBar?voiceBar.markup():''}</div>`;
 const locked=archived()||!usable()||S.busy,current=S.pip.model_choice?.mode==='model'?S.pip.model_choice.model:'',selected=modelValue(S.pip.model_choice),shownModel=S.pip.model_choice?.mode==='subscription'?modelLabel(S.pip.model_choice):current||defaultModelName()||'Same as DGC',available=S.apiVersion>=24&&!!S.chatControls,o=available?chosenChatOptions():null;
 const subs=subscriptionChoices(personalPip()),usage=subs.length?usageLine(selected):'';
 const unavailable=`<p class="composer-unavailable">${S.apiVersion<24?'Update DGC to change these settings.':'These settings didn’t load. Refresh, then send.'}</p>`;
 const effortLabel=o?EFFORT_NAME[o.thinking]||o.thinking:'';
 const effort=o?`<div class="composer-effort-control" style="--effort:${chatThinkingLevels.indexOf(o.thinking)/4*100}%"><label class="sr-only" for="chat-thinking">Thinking</label><input id="chat-thinking" class="composer-effort-slider" type="range" min="0" max="4" step="1" value="${chatThinkingLevels.indexOf(o.thinking)}" aria-valuetext="${esc(effortLabel)}" title="${esc(choiceScope())}"${locked?' disabled':''}><div class="composer-effort-labels"><span>Off</span><output for="chat-thinking">${esc(effortLabel)}</output><span>Extra high</span></div></div>${composerNote(choiceScope()+' '+S.chatControls.reasoning_note)}`:unavailable;
 const reviewed=!personalPip();
 const list=`<div class="composer-model-list"><label class="sr-only" for="chatModelSearch">Search models</label><input id="chatModelSearch" data-draft="chatModelSearch" value="${esc(draft.chatModelSearch)}" placeholder="Search models" autocomplete="off">${reviewed?'<p class="composer-scope">You’ll confirm a new model before it’s used. Work already started keeps the old one.</p>':''}<div class="composer-model-options" role="listbox" aria-label="Available models"><button type="button" role="option" data-chat-model="default" aria-selected="${selected==='default'}"${locked?' disabled':''}>Same as DGC${defaultModelName()?`<small>${esc(defaultModelName())}</small>`:''}</button>${subs.length?`<p class="composer-scope" role="presentation">Your subscriptions</p>${subs.filter(x=>x.name.toLowerCase().includes(draft.chatModelSearch.toLowerCase())).map(x=>`<button type="button" role="option" data-chat-model="subscription:${esc(x.engine)}" aria-selected="${selected==='subscription:'+x.engine}"${locked?' disabled':''}>${esc(x.name)}<small>Your own ${esc(x.name)}</small></button>`).join('')}${usage?`<p class="muted" data-usage-line role="presentation">${esc(usage)}</p>`:''}<p class="composer-scope" role="presentation">Models from your DGC connection</p>`:''}${S.models.filter(m=>(m.name+' '+m.id).toLowerCase().includes(draft.chatModelSearch.toLowerCase())).map(m=>`<button type="button" role="option" data-chat-model="model:${esc(m.id)}" aria-selected="${selected==='model:'+m.id}"${locked?' disabled':''}>${esc(m.name)}${m.name!==m.id?`<small>${esc(m.id)}</small>`:''}</button>`).join('')}</div>${S.modelsLoading?'<p class="muted" role="status">Loading models…</p>':''}${S.modelsError?errorMarkup(S.modelsError):''}${current&&!S.modelsLoading&&!S.models.some(m=>m.id===current)?'<p class="muted">The current model is absent from this list. Its saved choice remains unchanged.</p>':''}${button('chat-refresh-models','Refresh models',S.modelsLoading||locked)}</div>`;
 const modelMenu=S.composerPanel==='model'?`<div class="composer-model-menu composer-reasoning" role="dialog" aria-label="Model and thinking"><button type="button" id="chat-model-summary" class="composer-model-summary" aria-expanded="${S.modelListOpen}">${composerIcon('zap')}<span class="composer-summary-label">${esc(shownModel)}${o?` <span class="muted">${esc(effortLabel)}</span>`:''}</span>${composerIcon('next')}</button>${S.modelListOpen?list:effort}</div>`:'';
 const sizes=o?[...new Set([2048,4096,8192,16384,32768,65536,131072,262144,524288,1048576,o.context_size])].filter(n=>n<=S.chatControls.context_max).sort((a,b)=>a-b):[];
 const ctx=o&&S.chatContext&&S.chatContext.context_size===o.context_size?S.chatContext:null,pct=ctx?Math.min(100,Math.round(ctx.used_tokens/ctx.context_size*100)):null;
 const meter=ctx?`<div class="ctx-head"><div><span class="ctx-kicker">Context window</span><strong>${ctx.used_tokens.toLocaleString('en-US')} / ${ctx.context_size.toLocaleString('en-US')}</strong></div><span class="ctx-pct">${pct}%</span></div>${ctx.breakdown?`<div class="pip-ctx-breakdown" data-sig="${esc(ctx.breakdown.used+':'+ctx.breakdown.categories.map(c=>c.id+'='+c.tokens).join(','))}"></div>`:`<div class="ctx-track" aria-hidden="true"><span style="width:${pct}%"></span></div><div class="ctx-split"><span>${Math.max(0,ctx.context_size-ctx.used_tokens).toLocaleString('en-US')} free</span><span>${ctx.recent_messages} recent message${ctx.recent_messages===1?'':'s'}${ctx.summarized_messages?` · ${ctx.summarized_messages} in its brief`:''}</span></div>`}`:`<div class="ctx-head"><div><span class="ctx-kicker">Context window</span></div></div>`;
 const contextMenu=S.composerPanel==='context'?`<section class="composer-model-menu composer-context-menu" role="dialog" aria-label="Context window">${meter}${o?`<div class="composer-context-size"><label for="chat-context">Window size</label><select id="chat-context" aria-label="Context window" title="${esc(choiceScope())}"${locked?' disabled':''}>${sizes.map(n=>`<option value="${n}"${o.context_size===n?' selected':''}>${n===1048576?'1M':n%1024===0?n/1024+'K':n.toLocaleString()}</option>`).join('')}</select></div>${composerNote(`${choiceScope()} Pips supports 2,048–${S.chatControls.context_max.toLocaleString()} tokens; main DGC requests ${S.chatControls.inherited_context_size.toLocaleString()}. ${S.chatControls.context_note}`)}${continuityMarkup()}`:unavailable}</section>`:'';
 // An empty box offers voice mode where Send is, as ChatGPT does; a word typed, and it's Send again.
 const offerVoice=!!voiceMode&&!busy&&canSend&&!draft.chatText.trim()&&!(canAttachImages()&&(pendingImages().length||pendingFiles().length));
 const action=offerVoice?`<button type="button" id="chat-voicemode" class="chat-send ready" aria-label="Voice mode" title="Voice mode: talk with ${esc(S.pip?.name||'this Pip')}"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 6.5v3M6 4v8M10 3v10M13 6v4"/></svg></button>`:busy?`<button type="button" id="chat-stop" class="composer-chip" title="Stop generation" aria-label="Stop generation"${S.busy||!usable()?' disabled':''}>${composerIcon('stop')}</button>`:`<button type="submit" class="chat-send${canSend&&(draft.chatText.trim()||canAttachImages()&&(pendingImages().length||pendingFiles().length))?' ready':''}" aria-label="Send message" title="Send message"${canSend?'':' disabled'}>${composerIcon('up')}</button>`;
 return `${modelMenu}${contextMenu}<div class="composer-controls"><div class="composer-left">${canAttachImages()?`<button type="button" id="chat-attach" class="composer-chip" title="Add images and files" aria-label="Add images and files"${S.busy||archived()?' disabled':''}>${composerIcon('image')}</button><input type="file" id="chat-attach-input" accept="${[...PIP_IMAGE_TYPES,...(spoolsPhotos()?[...PIP_HEIC_TYPES,'.heic','.heif']:[]),...PIP_FILE_EXTENSIONS].join(',')}" multiple hidden>`:''}<button type="button" id="chat-context-toggle" class="composer-chip${pct===null?'':' with-text'}" title="Context window${o?' · '+o.context_size.toLocaleString()+' tokens':''}${pct===null?'':' · '+pct+'% used'}" aria-label="Context window${pct===null?'':': '+pct+' percent used'}" aria-haspopup="dialog" aria-expanded="${S.composerPanel==='context'}">${composerIcon('context')}${pct===null?'':`<span class="composer-ctx-pct">${pct}%</span>`}</button><button type="button" id="chat-permissions" class="composer-chip" title="What ${esc(S.pip.name)} can do" aria-label="What this Pip can do">${composerIcon('shield')}<span class="sr-only">What it can do</span></button></div><div class="composer-right"><button type="button" id="chat-model" class="model-control" aria-label="Change model and thinking" aria-haspopup="dialog" aria-expanded="${S.composerPanel==='model'}" title="${esc(shownModel)}${o?' · '+esc(effortLabel):''} — change model and thinking"${locked?' disabled':''}><span class="model-copy"><span class="composer-model-name">${esc(shownModel)}</span>${o?`<span class="composer-effort-name">${esc(effortLabel)}</span>`:''}</span><span class="composer-chevron">${composerIcon('chevron')}</span></button>${voiceBar?`<button type="button" id="chat-mic" class="composer-chip" title="Dictate" aria-label="Dictate"${!usable()||archived()||busy?' disabled':''}>${composerIcon('mic')}</button>`:''}${action}</div></div>`;
}
function fitChatInput(){const input=$('chatText');if(!input)return;const sendButton=document.querySelector('.chat-send');sendButton?.classList.toggle('ready',!sendButton.disabled&&!!draft.chatText.trim()||!sendButton.disabled&&canAttachImages()&&(pendingImages().length>0||pendingFiles().length>0));if(!input.isConnected||input.clientWidth<40||document.hidden)return;input.style.height='auto';const content=input.scrollHeight,capped=content>=160;input.style.overflowY=capped?'auto':'hidden';input.style.height=(capped?160:content+1)+'px';}
// What the prompt box's choices are for: since API 47 they are this Pip's own (its replies and the work it does on
// its own, saved at once); before, only the next reply.
function choiceScope(){return S.apiVersion>=47?'For this Pip: its replies and the work it does on its own.':'For the next reply.';}
async function saveChatPreference(pip,options){
 if(S.apiVersion<47||remoteHost)return;
 const token=scope();
 try{const v=await send('set_pip_chat_options',{pip_id:pip,chat_options:options});if(token!==scope()||S.selected!==pip||!record(v))return;S.chatControls=checkedChatControls(v.chat_controls);render();}
 catch(error){if(token===scope()&&S.selected===pip)setError(error);}
}
function updateChatPreference(kind,value){
 if(S.apiVersion<24||!S.chatControls||!S.selected||!usable()||S.busy||archived())return;
 try{const previous=chosenChatOptions(),next=checkedChatOptions({...previous,[kind]:kind==='context_size'?Number(value):value});chatPreferences.set(S.selected,next);S.error='';render();if(kind==='context_size')void loadChatContext();void saveChatPreference(S.selected,next);}catch(error){setError(error);}
}
function reviewChatModel(value){
 if(!usable()||S.busy||archived()||!S.pip)return;
 let choice;try{choice=modelChoice(value,S.models,subscriptionChoices(personalPip()));}catch(error){setError(error);return;}
 S.composerPanel='';draft.chatModelSearch='';const current=S.pip.model_choice||{mode:'default'};if(JSON.stringify(choice)===JSON.stringify(current)){render();return;}
 if(personalPip()){const name=choice.mode==='model'?(S.models.find(m=>m.id===choice.model)?.name||choice.model):choice.mode==='subscription'?modelLabel(choice):'the same model as DGC',usage=usageLine(modelValue(choice));void applyOwnChange({model_choice:choice},d=>JSON.stringify(d.model_choice)===JSON.stringify(choice),`${S.pip.name} now uses ${name}.${usage?' '+usage:''}`);return;}
 const version=S.pip.current_version,pip=S.selected;
 void mutate({type:'propose_pip_update',pip_id:pip,expected_version:version,changes:{model_choice:choice},reason:'Model selected in this Pip conversation.'},result=>{const proposal=result.proposal;if(!record(proposal)||proposal.pip_id!==pip||proposal.expected_version!==version||!record(proposal.definition)||JSON.stringify(proposal.definition.model_choice)!==JSON.stringify(choice))throw Error('The saved model choice differs from the selection. Refresh before reviewing it.');S.pip={...S.pip,proposals:[...(S.pip.proposals||[]).filter(p=>p.id!==proposal.id),proposal]};S.notice='New model is waiting for you. Nothing changes until you accept it.';proposalReview(proposal.id);});
}
function chatResultCards(){
  if(!executionPip(S.pip))return '';
  // A Pulse's own command plan runs say what they found in its chat (pipRunPosts.js); a card for each said it twice.
  return S.runs.filter(r=>r.pip_id===S.selected&&['patch','test'].includes(r.manifest?.run_kind)&&!(postsShown()&&r.execution_mode==='standalone_plan')).slice(0,3).map(run=>{
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
// Core's catalog entry is "unavailable" (it cannot be made as a background Pip), but a Personal Core is
// the user's Primary Pip and takes messages like any Pip: battle test 4 found its chat could never send.
function takesMessages(){return !!(pipType(S.pip,S.types)?.available||personalPip()&&S.pip?.pip_type==='core');}
// The working row, as DGC's: who, what it is doing ("Thinking", "Loading the model", a tool's verb,
// "Writing"), then (time · ↓ tokens). The clock ticks in place (workingClock), without a render.
function workingWords(sending){
  const name=esc(S.pip.name),run=S.chatActiveRun,act=S.stream?.runId===run?.id?S.stream?.activity:null;
  if(!S.runner?.online)return `<span>${name} will answer when your Pips are running</span>`;
  if(sending||run?.status==='queued'||!run)return `<span>${name} is getting ready</span>`;
  const since=Date.parse(run.started_at||run.created_at),chars=S.stream?.runId===run.id?S.stream.text.length:0;
  return `<span class="pip-working-verb">${name} · ${esc(act?act.label:'Working')}</span>${Number.isFinite(since)?`<span class="pip-working-meta" data-since="${since}" data-chars="${chars}">${workingMeta(since,chars)}</span>`:''}`;
}
function workingMeta(since,chars){return `(${Math.max(0,Math.floor((Date.now()-since)/1000))}s · ↓ ${Math.round(chars/4)} tok)`;}
const workingClock=window.setInterval(()=>{for(const el of document.querySelectorAll('.pip-working-meta'))el.textContent=workingMeta(Number(el.dataset.since),Number(el.dataset.chars));},1000);
function chatMarkup(){
  const type=pipType(S.pip,S.types),busy=S.chatActiveRun,canSend=(S.apiVersion<24||!!S.chatControls)&&!archived()&&S.messagesLoaded&&usable()&&takesMessages()&&supportedSource()&&S.runner?.online&&!S.runner?.paused&&!S.busy&&!busy;
  const markdown=renderPipMarkdown;
  const sending=S.sending&&S.sending.pip===S.selected&&!S.messages.some(m=>m.role==='user'&&m.text===S.sending.text&&Date.parse(m.created_at)>=Date.parse(S.sending.at)-60000)?S.sending:null;
  const shown=[...S.messages.filter(m=>!(m.role==='user'&&m.intro===true)),...(sending?[{id:'sending',pip_id:S.selected,workspace_id:S.workspace?.id,role:'user',text:sending.text,status:'sending',created_at:sending.at}]:[])];
  // While it answers, the Pip itself is in the chat, at work, with its name: the reply replaces it.
  const simple=simpleMode(),typing=(busy||sending)&&(simple||S.messages.some(m=>m.role==='user'&&m.intro===true&&m.run_id===S.chatActiveRun?.id))&&(simple||!S.stream?.text)
   ?(simple?`<div class="pip-working" role="status">${pipAvatar(S.pip,'working',`working-${S.pip.id}`,type||characterType(S.pip.pip_type))}${workingWords(sending)}</div>`
    :`<article class="pip-message assistant typing" aria-label="${esc(S.pip.name)} is writing"><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span></article>`):'';
  let last=null;
  // A run's message has its own time beside the Pip's name: it moves the clock on without a mark of its own.
  const timed=(m,mark=true)=>{const at=Date.parse(m.created_at),line=mark&&simple&&Number.isFinite(at)&&(last===null||at-last>30*60*1000)?`<p class="chat-time">${esc(chatTime(at))}</p>`:'';if(Number.isFinite(at))last=at;return line;};
  const latest=S.messages.at(-1),answerable=latest&&latest.role==='assistant'&&Array.isArray(latest.choices)?latest:null;
  const drawMessage=m=>{
    const prompt=S.messages.find(p=>p.role==='user'&&p.run_id===m.run_id),routine=m.role==='assistant'&&prompt?.intro===true?postRoutineTitle(prompt.text):null;
    return timed(m,!routine)+messageMarkup(m,{imageSrc:messageImageSrc,pluginLogo:pluginLogoSrc,split:simple,name:S.pip?.name||type?.name||'Pip',formatDate:date,renderMarkdown:markdown,canSend,prompt,activity:chatActivities.get(m.run_id),choices:m===answerable?m.choices:null,stats:m.role==='assistant'?replyStats.get(m.run_id):null,...(routine?routineReply(m,routine,type):{})});
  };
  // Its runs, each a message from the Pip where it falls among the messages, all-clear runs in a row as one (Pips API
  // 51, pipRunPosts.js).
  const items=postsShown()?timeline(shown,S.posts,{complete:!S.messageCursor}):shown.map(m=>({message:m}));
  const context=postsShown()?postContext():null;
  const drawPost=i=>{const p=i.streak?i.streak.at(-1):i.post,first=i.streak?i.streak[0]:p;
    return timed({created_at:p.posted_at},false)+postMarkup(p,{...context,previous:i.previous,streak:i.streak||null,face:pipAvatar(S.pip,['failed','checks_failed'].includes(p.outcome)?'failure':'idle',`post-${first.run_id}`,context.type),asked:askedRuns.has(p.run_id),expanded:shownInFull.has(p.run_id)});};
  const messages=items.map(i=>i.message?drawMessage(i.message):drawPost(i)).join('');
  const quietChat=!S.messages.length&&!items.length;
  return `<section class="pip-conversation" aria-label="Pip conversation"><div class="conversation-log" role="log" aria-live="polite">${errorMarkup(S.error)}${S.notice?`<p class="notice" role="status">${esc(S.notice)}</p>`:''}${(S.messageCursor&&S.messages.length<200)||(postsShown()&&S.postsCursor&&!S.messageCursor)?button('older-messages','Load earlier messages',S.messagesLoading||S.postsLoading||!usable()):''}${S.messages.length>=200?'<p class="muted">Showing the latest 200 loaded messages. Earlier messages remain saved.</p>':''}${S.messagesError?errorMarkup(S.messagesError):''}${!S.messagesLoaded?'<p role="status" class="muted">Loading conversation…</p>':quietChat?`<div class="conversation-empty"><h3>Talk to ${esc(type?.name||'this Pip')}</h3><p class="muted">${personalPip()?'Talk about your plans, ask questions, or share details to work with.':'Ask about '+(currentTree()?'your current files':'the committed code')+' in this project.'} ${esc(S.pip.name)} keeps this chat.</p><p class="muted">${personalPip()?'It sees only what you share here. To use an app like Gmail, ask it to connect one.':type?esc(type.description):'Unsupported Pip type.'}</p></div>`:''}${messages}${simple?'':typing}${S.stream?.text?`<article class="pip-message assistant dgc provisional" aria-label="Live reply preview"><span class="sr-only">${esc(type?.name||'Pip')}</span>${simple?'':'<p class="message-status">Still writing…</p>'}${simple?`<div class="answer split">${replyParts(S.stream.text).map(part=>`<div class="message-body text reply-part">${markdown(part)}</div>`).join('')}</div>`:`<div class="message-body text">${markdown(S.stream.text)}</div>`}${S.stream.limited?'<p class="muted">Showing the start of the reply. The whole reply appears when it’s done.</p>':''}</article>`:''}${S.stream?.error?`<p class="muted">${esc(S.stream.error)}</p>`:''}${simple?typing:''}${memoryKept()}${learnCard()}${chatResultCards()}${chatSetupCards()}${emailDraftCards()}${appLinkCards()}${pluginCards()}${borrowCards()}${routineCards()}${computerWaitingCards()}${needsYouCard()}${cardRefusedCard()}${S.omitted?`<p class="context-limit">${esc(S.pip.name)} no longer sees your ${S.omitted===1?'earliest message':S.omitted+' earliest messages'}. ${S.omitted===1?'It’s':'They’re'} still saved here.</p>`:''}</div>${simpleMode()?runnerOffMarkup():''}<form id="chat-form" class="pip-composer">${canAttachImages()?imageStripMarkup():''}<div class="composer-input"><label class="sr-only" for="chatText">Message ${esc(type?.name||'this Pip')}</label><textarea id="chatText" data-draft="chatText" rows="1" placeholder="${simpleMode()?`Ask ${esc(S.pip.name)}`:`Message ${esc(type?.name||'this Pip')}…`}" maxlength="4000"${archived()||!usable()?' disabled':''}>${esc(draft.chatText)}</textarea></div>${chatControlsMarkup(canSend,busy)}</form><p class="composer-hint">${personalPip()?[archived()?'Archived. Restore it in Settings to chat again.':'',!S.runner?.online?'Start Pips to send a message.':S.runner?.paused?'Resume Pips to send a message.':''].filter(Boolean).join(' '):`${archived()?'Archived · Restore to paused before sending another message. ':''}${(currentTree()?'Your current files':'Committed code')+' · reads only'}${!S.runner?.online?' · Start Pips to send a message.':S.runner?.paused?' · Resume Pips to send a message.':''}`}</p></section>`;
}
// ---- Its runs in its chat (Pips API 51) ----
// Each finished run is a post from the Pip, read with list_pip_run_posts and drawn among the messages; History
// (was Runs) uses the same posts to say what each run found, and the status under its name jumps to the latest.
function postsShown(){return S.apiVersion>=51&&!remoteHost;}
function postFor(runId){return S.posts.find(p=>p.run_id===runId)||null;}
// Ask DGC to fix goes to a Work chat, which only the host can reach: the chat the Pip reports to, else a new one.
function canAskDgc(){return typeof options.onAskDgc==='function'&&!remoteHost&&!personalPip();}
function canRunNow(){return supportedSource()&&(!executionPip(S.pip)||livePip(S.pip)&&S.apiVersion>=60)&&S.runner?.online&&!S.runner.paused&&S.pip?.status==='active'&&!!pipType(S.pip,S.types)?.available&&!S.pip.active_run&&!S.runs.some(r=>active(r.status))&&!S.busy&&usable();}
// A routine's reply (pip_routines) is the Pip's own message, said without being asked: like a run's, it says who and
// which routine, and a long one starts short with Show all.
function routineReply(m,title,type){
  const cut=shortReply(m.text),look=type||characterType(S.pip.pip_type);
  const head=`<div class="run-post-head"><span class="run-post-face" aria-hidden="true">${pipAvatar(S.pip,'idle',`routine-${m.id}`,look)}</span><strong class="run-post-name">${esc(S.pip.name)}</strong><span class="run-post-routine">${esc(title)}</span>${globalThis.DgcTime?.markup(Date.parse(m.created_at))||''}</div>`;
  return {head,clip:cut.clipped?{text:cut.text,open:shownInFull.has(m.id),key:m.id}:null};
}
function postContext(){
  return {name:S.pip.name,type:pipType(S.pip,S.types)||characterType(S.pip.pip_type),personal:personalPip(),ask:canAskDgc(),canRun:canRunNow(),renderMarkdown:renderPipMarkdown};
}
async function loadPosts(more=false){
  if(!postsShown()||!S.selected||!usable()||(more&&(!S.postsCursor||S.postsLoading)))return;
  const token=scope(),id=S.selected,sequence=++postsSeq,before=more?S.postsCursor:null;S.postsLoading=true;
  try{const page=runPostsPage(await send('list_pip_run_posts',{pip_id:id,limit:more?50:30,...(before?{before_id:before}:{})}),id,S.workspace.id);
    if(token!==scope()||sequence!==postsSeq||S.selected!==id)return;
    S.posts=mergePosts(S.postsPip===id?S.posts:[],page.posts);S.postsPip=id;
    if(more||!S.postsLoaded)S.postsCursor=page.next_before_id;S.postsLoaded=true;S.postsError='';
  }catch(error){if(token===scope()&&sequence===postsSeq)S.postsError=errorText(error);}
  finally{if(token===scope()&&sequence===postsSeq){S.postsLoading=false;render();}}
}
// Open full report: the run, under History, at its report.
function openPostReport(runId){S.tab='runs';S.overview=false;rememberView();render();void loadRun(runId).then(()=>document.querySelector('section[aria-label="Run report"],section[aria-label="Pulse command receipt"],section[aria-label="Documentation draft"]')?.scrollIntoView?.({block:'start'}));}
// The status under its name: to its post in the chat, which says what it found.
function jumpToPost(runId){
  S.tab='chat';S.overview=false;rememberView();render();
  const go=()=>{const el=document.querySelector(`[data-run-post="${runId}"]`)||document.querySelector(`[data-streak-run="${runId}"]`);if(!el)return false;el.closest('details')?.setAttribute('open','');el.scrollIntoView?.({block:'center'});el.focus?.({preventScroll:true});el.classList.add('run-post-flash');window.setTimeout(()=>el.classList.remove('run-post-flash'),1600);return true;};
  if(!go())void loadMessages().then(()=>{if(!go())openPostReport(runId);});
}
function askDgcAbout(runId){
  const post=postFor(runId);if(!post||!canAskDgc()||askedRuns.has(runId))return;
  const result=options.onAskDgc({report:post,session:typeof S.pip?.report_session==='string'?S.pip.report_session:''});
  if(result!==true){setError(typeof result==='string'?result:'DGC could not reach the Work chat.');return;}
  askedRuns.add(runId);rememberView();S.notice='Asked DGC in the Work chat.';render();
}
function runNow(){if(livePip(S.pip)){try{if(S.apiVersion<60)throw Error('Update DGC to run a live-data Pip.');if(!S.runner?.online||S.runner.paused||S.pip.status!=='active'||S.pip.active_run||S.runs.some(r=>active(r.status)))return;void mutate({type:'run_pip',pip_id:S.selected,idempotency_key:`editor-${globalThis.crypto.randomUUID()}`},async result=>{await loadRun(result.run.id);});}catch(error){setError(error);}return;}if(pulsePip(S.pip)){try{if(S.apiVersion<21)throw Error('Update DGC to run Pulse’s command plan.');if(!supportedSource()||!S.runner?.online||S.runner.paused||S.pip.status!=='active'||S.pip.active_run||S.runs.some(r=>active(r.status)))return;const pins=pulseRunPins(S.pip);void mutate({type:'run_pip',pip_id:S.selected,idempotency_key:`editor-${globalThis.crypto.randomUUID()}`,...pins},async result=>{await loadRun(result.run.id);});}catch(error){setError(error);}return;}if(supportedSource()&&!executionPip(S.pip)&&S.runner?.online&&!S.runner.paused&&S.pip?.status==='active'&&pipType(S.pip,S.types)?.available&&!S.pip.active_run)void mutate({type:'run_pip',pip_id:S.selected,idempotency_key:`editor-${Date.now()}-${globalThis.crypto.randomUUID()}`},async result=>{await loadRun(result.run.id);});return;}
async function toggleChatActivity(runId){
  if(!S.messages.some(m=>m.run_id===runId)||!usable())return;
  const current=chatActivities.get(runId);if(current){current.open=!current.open;render();return;}
  const token=scope(),value={open:true,loading:true,events:[],error:'',hasMore:false,truncated:false};chatActivities.set(runId,value);render();
  try{const page=activityPage(await send('list_pip_run_activity',{run_id:runId,after:0}),{id:runId,pip_id:S.selected,workspace_id:S.workspace.id},0);if(token!==scope()||chatActivities.get(runId)!==value)return;value.events=page.events;value.hasMore=page.has_more;value.truncated=page.history_may_be_truncated;}
  catch(error){if(token===scope()&&chatActivities.get(runId)===value)value.error=errorText(error);}
  finally{if(token===scope()&&chatActivities.get(runId)===value){value.loading=false;render();}}
}
async function loadMessages(more=false){
 if(!more){void loadEmailDrafts();void loadAppLinks();void loadPlugins();void loadBorrows();void loadRoutines();void loadNotes();void loadWorkingNotes();void loadDailyLog();void refreshComputer();if(personalPip()&&!S.models.length&&!S.defaultModel)void loadModels();}
  if(!S.selected||!usable()||(more&&(!S.messageCursor||S.messagesLoading||S.messages.length>=200)))return;
  const token=scope(),id=S.selected,sequence=++messageSeq,before=more?S.messageCursor:null;S.messagesLoading=true;
  if(!S.messagesLoaded)render();
  try{const page=messagesPage(await send('list_pip_messages',{pip_id:id,limit:20,...(before?{before_id:before}:{})}),id,S.workspace.id);if(token!==scope()||sequence!==messageSeq)return;if(S.apiVersion>=24){S.chatControls=null;S.chatControls=checkedChatControls(page.chat_controls);if(!chatPreferences.has(id))chatPreferences.set(id,{...S.chatControls.options});if(!before)void loadChatContext();}
    if(more){if(page.next_before_id===before||page.messages.some(m=>S.messages.some(p=>p.id===m.id)))throw new Error('Conversation history did not advance. Refresh before retrying.');S.messages=[...page.messages,...S.messages].slice(-200);S.messageCursor=page.next_before_id;}
    else{const existing=new Map(S.messages.map((m,i)=>[m.id,i]));const next=[...S.messages];for(const m of page.messages){if(existing.has(m.id))next[existing.get(m.id)]=m;else next.push(m);}if(!S.messagesLoaded)S.messageCursor=page.next_before_id;S.messages=next.slice(-200);}
    S.messagesLoaded=true;S.messagesError='';S.chatActiveRun=page.active_run;S.omitted=page.history_context_omitted_count;S.continuity=chatContinuity(page.continuity,id,S.workspace.id);
    if(!more)voiceMode?.check(!!page.active_run);
    if(!page.active_run){streamSeq++;streamLoading=false;S.stream=null;}else if(!S.stream||S.stream.runId!==page.active_run.id){streamSeq++;streamLoading=false;S.stream={runId:page.active_run.id,cursor:0,text:'',limited:false,error:'',truncated:false};}
    if(page.active_run)void loadChatStream();
    if(!more)void loadReplyStats();
  }catch(error){if(token===scope()&&sequence===messageSeq)S.messagesError=errorText(error);}
  finally{if(token===scope()&&sequence===messageSeq){S.messagesLoading=false;render();}}
}
// What each reply took (list_pip_reply_stats, API 44): read once per finished reply, kept for the view.
const replyStats=new Map();let replyStatsSeq=0;
async function loadReplyStats(){
  if(remoteHost||S.apiVersion<44||!personalPip()||!usable())return;
  const pip=S.selected,token=scope(),sequence=++replyStatsSeq;
  const runs=[...new Set(S.messages.filter(m=>m.role==='assistant'&&m.status==='succeeded'&&/^run_[a-f0-9]{32}$/.test(m.run_id||'')&&!replyStats.has(m.run_id)).map(m=>m.run_id))].slice(-50);
  if(!runs.length)return;
  try{const v=await send('list_pip_reply_stats',{pip_id:pip,run_ids:runs});if(token!==scope()||S.selected!==pip||sequence!==replyStatsSeq||!record(v)||v.pip_id!==pip||!Array.isArray(v.stats))return;
   for(const s of v.stats.slice(0,50))if(record(s)&&runs.includes(s.run_id)&&(s.seconds===null||Number.isFinite(s.seconds))&&[s.input_tokens,s.output_tokens,s.requests].every(n=>Number.isSafeInteger(n)&&n>=0))replyStats.set(s.run_id,s);
   render();}
  catch{/* the line is left out */}
}
// While a reply runs, its stream is read every 400 ms (the chat's own refresh is every 4 s), so it
// reads as it is written, with DGC's working row: what it is doing, its clock and its tokens.
let streamTimer=0;
async function loadChatStream(){
  if(!S.stream||streamLoading||S.stream.limited||!usable())return;
  window.clearTimeout(streamTimer);
  const token=scope(),runId=S.stream.runId,identity={id:runId,pip_id:S.selected,workspace_id:S.workspace.id},sequence=++streamSeq;streamLoading=true;let changed=false,ended=false;
  try{for(let pageNumber=0;pageNumber<4;pageNumber++){
    const after=S.stream.cursor,page=activityPage(await send('list_pip_run_activity',{run_id:runId,after}),identity,after);
    if(token!==scope()||sequence!==streamSeq||S.stream?.runId!==runId)return;
    S.stream.cursor=page.next_cursor;S.stream.truncated ||= page.history_may_be_truncated;
    for(const event of page.events){changed=true;
      if(event.event_type==='pip_run_progress'&&event.payload.kind==='text_delta'&&typeof event.payload.text==='string'){
        const available=16384-S.stream.text.length;S.stream.text+=event.payload.text.slice(0,available);if(event.payload.text.length>available)S.stream.limited=true;
      }else if(event.event_type==='pip_run_progress'&&event.payload.kind==='progress'&&typeof event.payload.state==='string'&&typeof event.payload.message==='string'&&event.payload.message)S.stream.activity={state:event.payload.state.slice(0,40),label:event.payload.message.slice(0,120)};
      else if(/^pip_run_(succeeded|failed|cancelled)$/.test(event.event_type))ended=true;
    }
    S.stream.error='';if(!page.has_more||S.stream.limited)break;
  }}catch(error){if(token===scope()&&sequence===streamSeq&&S.stream){S.stream.error='The reply will appear when it’s done.';changed=true;}}
  finally{if(token===scope()&&sequence===streamSeq){streamLoading=false;if(changed)render();
    if(ended)void loadMessages();       // the reply is saved: show it now, not at the next 4 s refresh
    else if(S.stream?.runId===runId&&S.tab==='chat'&&S.visible&&!document.hidden)streamTimer=window.setTimeout(()=>{void loadChatStream();},400);}}
}
// Images in a Pip's chat (API 43): added with the image button, pasted or dropped, shown as previews, and
// sent with the message. Inline (API 43–51) they ride inside the request: up to four, 2 MB in all with any
// files. From API 52 the host hands them to DGC the Work chat's way (its spool), so a photo can be 8 MB and
// a message 32 MB of photos, with no four-photo cap; an iPhone photo (HEIC) goes too, and DGC turns it into a
// JPEG (Chromium can't show one, so its chip names it until it is sent).
const PIP_IMAGE_TYPES=['image/png','image/jpeg','image/gif','image/webp','image/bmp'],PIP_HEIC_TYPES=['image/heic','image/heif'],PIP_MAX_IMAGES=4,PIP_MAX_IMAGE_BYTES=2*1024*1024;
const MB=1024*1024,PIP_SPOOL_IMAGES=64,PIP_PHOTO_BYTES=8*MB,PIP_PHOTOS_BYTES=32*MB,PIP_SPOOL_FILES=16,PIP_DOCUMENT_BYTES=16*MB,PIP_TEXT_FILE_BYTES=MB,PIP_FILES_BYTES=32*MB;
const PIP_DOCUMENT_EXTENSIONS=['.pdf','.docx','.xlsx','.pptx','.odt','.ods','.odp','.rtf'];
const chatImages=new Map(),messageImageCache=new Map(),messageImageFlight=new Set();
// Plugin logos for "Used [logo] Aave", by plugin id: the host reads each once (a data: URI; "" for none).
const pluginLogoCache=new Map(),pluginLogoAsked=new Set();
// Files go with a message too, as in the main chat: text and code, PDF, Word, Excel, PowerPoint,
// OpenDocument, RTF, CSV and TSV. Inline, up to 4 and 2 MB in all with any images; from API 52, the Work
// chat's limits: up to 16, a document up to 16 MB, a text or code file up to 1 MB, 32 MB in all.
const PIP_FILE_EXTENSIONS=['.pdf','.docx','.xlsx','.pptx','.odt','.ods','.odp','.rtf','.csv','.tsv','.txt','.md','.markdown','.rst','.log','.json','.jsonl','.yaml','.yml','.toml','.ini','.cfg','.conf','.xml','.html','.htm','.css','.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.rb','.go','.rs','.java','.kt','.swift','.c','.h','.cpp','.hpp','.cs','.php','.sh','.sql','.r','.ipynb','.srt','.vtt','.tex','.bib','.svg','.ics','.vcf','.eml'],PIP_MAX_FILES=4;
const chatFiles=new Map();
function pendingFiles(){return chatFiles.get(S.selected)||[];}
function fileExtension(name){const i=name.lastIndexOf('.');return i>0?name.slice(i).toLowerCase():'';}
function fileSize(n){return n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(n<10240?1:0)} KB`:`${(n/1048576).toFixed(1)} MB`;}
function canAttachImages(){return S.apiVersion>=43&&!remoteHost&&personalPip();}
function spoolsPhotos(){return S.apiVersion>=52;}
function pendingImages(){return chatImages.get(S.selected)||[];}
function heicFile(f){return PIP_HEIC_TYPES.includes(String(f.type||'').toLowerCase())||!f.type&&['.heic','.heif'].includes(fileExtension(f.name||''));}
function imageStripMarkup(){
 const images=pendingImages(),files=pendingFiles();if(!images.length&&!files.length)return '';
 // An iPhone photo can't be drawn here (Chromium has no HEIC); its chip says what it is, and DGC sends it as a JPEG.
 return `<div class="chat-images" aria-label="Images and files to send">${images.map((image,i)=>image.heic?`<span class="chat-file-chip chat-heic-chip" title="${esc(image.name)}: an iPhone photo, sent as a JPEG"><span class="chat-file-ext" aria-hidden="true">heic</span><span class="chat-file-name">${esc(image.name)}</span><span class="chat-file-size">${esc(fileSize(image.bytes))}</span><button type="button" data-remove-image="${i}" aria-label="Remove ${esc(image.name)}" title="Remove">×</button></span>`:`<span class="chat-image-chip"><img src="${esc(image.data)}" alt="Image ${i+1} to send"><button type="button" data-remove-image="${i}" aria-label="Remove image ${i+1}" title="Remove">×</button></span>`).join('')}${files.map((file,i)=>`<span class="chat-file-chip" title="${esc(file.name)}"><span class="chat-file-ext" aria-hidden="true">${esc((fileExtension(file.name).slice(1)||'txt').slice(0,4))}</span><span class="chat-file-name">${esc(file.name)}</span><span class="chat-file-size">${esc(fileSize(file.bytes))}</span><button type="button" data-remove-file="${i}" aria-label="Remove ${esc(file.name)}" title="Remove">×</button></span>`).join('')}</div>`;
}
function addImageFiles(files){
 if(!canAttachImages()||!S.selected)return;
 const pip=S.selected,all=[...files],spool=spoolsPhotos();
 const heics=all.filter(heicFile),list=all.filter(f=>PIP_IMAGE_TYPES.includes(f.type)||spool&&heicFile(f)),docs=all.filter(f=>!PIP_IMAGE_TYPES.includes(f.type)&&!heicFile(f));
 if(heics.length&&!spool)setError('Update DGC to send iPhone photos.');
 const usable=docs.filter(f=>PIP_FILE_EXTENSIONS.includes(fileExtension(f.name))&&f.name.length<=255&&!/[\/\\"\u0000-\u001f]/.test(f.name));
 if(usable.length<docs.length)setError('Add images, text or code files, or PDF, Word, Excel, PowerPoint, OpenDocument, RTF, CSV or TSV files.');
 if(!list.length&&!usable.length)return;
 const images=pendingImages(),filesNow=pendingFiles();
 const takeImages=list.slice(0,Math.max(0,(spool?PIP_SPOOL_IMAGES:PIP_MAX_IMAGES)-images.length)),takeFiles=usable.slice(0,Math.max(0,(spool?PIP_SPOOL_FILES:PIP_MAX_FILES)-filesNow.length));
 if(spool){
  // The Work chat's limits, one plain sentence each.
  if(takeImages.length<list.length){setError(`Send up to ${PIP_SPOOL_IMAGES} photos with one message.`);return;}
  if(takeFiles.length<usable.length){setError(`Send up to ${PIP_SPOOL_FILES} files with one message.`);return;}
  const big=takeImages.find(f=>f.size>PIP_PHOTO_BYTES);if(big){setError(`${big.name||'That photo'} is over 8 MB; send a smaller photo.`);return;}
  if(images.reduce((n,i)=>n+i.bytes,0)+takeImages.reduce((n,f)=>n+f.size,0)>PIP_PHOTOS_BYTES){setError('Send up to 32 MB of photos with one message.');return;}
  const over=takeFiles.find(f=>f.size>(PIP_DOCUMENT_EXTENSIONS.includes(fileExtension(f.name))?PIP_DOCUMENT_BYTES:PIP_TEXT_FILE_BYTES));
  if(over){setError(PIP_DOCUMENT_EXTENSIONS.includes(fileExtension(over.name))?`${over.name} is over 16 MB; send a document of 16 MB or less.`:`${over.name} is over 1 MB; send a text or code file of 1 MB or less.`);return;}
  if(filesNow.reduce((n,f)=>n+f.bytes,0)+takeFiles.reduce((n,f)=>n+f.size,0)>PIP_FILES_BYTES){setError('Send up to 32 MB of files with one message.');return;}
 }else{
  const used=images.reduce((n,i)=>n+i.bytes,0)+filesNow.reduce((n,f)=>n+f.bytes,0),bytes=used+takeImages.reduce((n,f)=>n+f.size,0)+takeFiles.reduce((n,f)=>n+f.size,0);
  if(takeImages.length<list.length||takeFiles.length<usable.length)setError(`Send up to ${PIP_MAX_IMAGES} images and ${PIP_MAX_FILES} files with one message.`);
  if(bytes>PIP_MAX_IMAGE_BYTES){setError('Send up to 2 MB of images and files with one message.');return;}
 }
 const cap=spool?PIP_SPOOL_IMAGES:PIP_MAX_IMAGES,fileCap=spool?PIP_SPOOL_FILES:PIP_MAX_FILES;
 // Each is read in the background; they join the message in the order you picked them, not the order they finish.
 const read=file=>new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(typeof reader.result==='string'?reader.result:'');reader.onerror=()=>resolve('');reader.readAsDataURL(file);});
 void Promise.all(takeImages.map(read)).then(results=>{
  const added=takeImages.map((file,i)=>{const heic=heicFile(file),result=results[i];if(!result.startsWith(heic?'data:':'data:image/'))return null;
   const data=heic?result.replace(/^data:[^;,]*(;[^,]*)?;base64,/,`data:${String(file.type||'').toLowerCase()==='image/heif'?'image/heif':'image/heic'};base64,`):result;
   return {data,bytes:file.size,...(heic?{heic:true,name:file.name||'iPhone photo'}:{})};}).filter(Boolean);
  if(!added.length)return;chatImages.set(pip,[...(chatImages.get(pip)||[]),...added].slice(0,cap));if(S.selected===pip)render();
 });
 const readable=takeFiles.filter(file=>{if(!file.size)setError(`${file.name} is empty.`);return !!file.size;});
 void Promise.all(readable.map(read)).then(results=>{
  const added=readable.map((file,i)=>results[i].startsWith('data:')?{name:file.name,data:results[i].replace(/^data:[^;,]*(;[^,]*)?;base64,/,'data:application/octet-stream;base64,'),bytes:file.size}:null).filter(Boolean);
  if(!added.length)return;chatFiles.set(pip,[...(chatFiles.get(pip)||[]),...added].slice(0,fileCap));if(S.selected===pip)render();
 });
}
function messageImageSrc(messageId,index){return messageImageCache.get(`${messageId}:${index}`)||'';}
function pluginLogoSrc(plugin){return pluginLogoCache.get(plugin)||'';}
function hydratePluginLogos(){
 const wanted=[...new Set([...document.querySelectorAll('[data-plugin-mark]')].map(n=>n.dataset.pluginMark))].filter(id=>!pluginLogoCache.has(id)&&!pluginLogoAsked.has(id)).slice(0,16);
 if(!wanted.length)return;
 for(const id of wanted)pluginLogoAsked.add(id);
 vscode.postMessage({type:'pipsPluginLogos',plugins:wanted});
}
function takePluginLogos(logos){
 if(!record(logos))return;
 for(const [id,src] of Object.entries(logos)){
  if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)||typeof src!=='string'||src&&!/^data:image\/(png|svg\+xml|x-icon);base64,/.test(src))continue;
  pluginLogoCache.set(id,src);
  if(!src)continue;
  for(const mark of document.querySelectorAll(`[data-plugin-mark="${id}"]`)){const img=document.createElement('img');img.alt='';img.src=src;mark.replaceChildren(img);}
 }
}
// A thumbnail of a big photo is drawn from the original once and kept small (a 12 MP photo is 48 MB once
// decoded); clicking it opens the original. A small image, or one this webview can't redraw, is kept as it is.
function thumbnail(uri){
 return new Promise(resolve=>{
  if(uri.length<600000||typeof Image!=='function'){resolve(uri);return;}
  const img=new Image();
  img.onload=()=>{try{const scale=Math.min(1,480/Math.max(img.naturalWidth,img.naturalHeight)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));const g=canvas.getContext('2d');if(!g){resolve(uri);return;}g.imageSmoothingQuality='high';g.drawImage(img,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL('image/jpeg',0.86));}catch{resolve(uri);}};
  img.onerror=()=>resolve(uri);img.src=uri;
 });
}
// Thumbnails of images already sent load one at a time, when their message is on screen.
function hydrateMessageImages(){
 for(const node of document.querySelectorAll('img[data-message-image]')){
  const key=node.dataset.messageImage;if(messageImageCache.has(key)){if(!node.getAttribute('src'))node.src=messageImageCache.get(key);continue;}
  if(messageImageFlight.has(key)||S.apiVersion<43)continue;
  const [messageId,index]=key.split(':'),pip=S.selected;messageImageFlight.add(key);
  send('get_pip_message_image',{pip_id:pip,message_id:messageId,index:Number(index)}).then(async result=>{
   if(!record(result)||result.message_id!==messageId||typeof result.image!=='string'||!/^data:image\/(png|jpeg|gif|webp|bmp);base64,/.test(result.image))return;
   const small=await thumbnail(result.image);
   messageImageCache.set(key,small);for(const img of document.querySelectorAll(`img[data-message-image="${key}"]`))img.src=small;
  }).catch(()=>{}).finally(()=>messageImageFlight.delete(key));
 }
}
function openMessageImage(key){
 const [messageId,index]=String(key||'').split(':');
 if(!S.selected||!messageId||!/^\d+$/.test(index||''))return;
 vscode.postMessage({type:'pipsOpenPhoto',pip_id:S.selected,message_id:messageId,index:Number(index)});
}
async function sendChat(){
  // Enter while the Pip is answering said nothing before; the draft stays in the box either way.
  if(S.chatActiveRun&&draft.chatText.trim()&&!S.busy){S.notice=`${S.pip?.name||'The Pip'} is still answering. Send this when it is done.`;render();return;}
  if(S.apiVersion>=24&&!S.chatControls||archived()||!supportedSource()||!usable()||!S.messagesLoaded||S.busy||!S.pip||!takesMessages()||!S.runner?.online||S.runner?.paused||S.chatActiveRun)return;
  const text=draft.chatText.trim(),images=canAttachImages()?pendingImages().map(i=>i.data):[],files=canAttachImages()?pendingFiles().map(f=>({name:f.name,data:f.data})):[];if(!text&&!images.length&&!files.length){setError('Enter a message.');return;}
  // /learn [what]: a skill drafted from this chat, shown here with Save, Edit and Cancel. It isn't a message to the Pip.
  const learning=personalPip()&&!images.length&&!files.length?learnRequest(text):null;if(learning){void startLearn(learning);return;}
  // A card number never leaves the box: not sent, not kept as a draft. The user types it on the Pip's screen.
  if(cardNumber(text)){refuseCard(S.selected);return;}if(text.length>4000||new TextEncoder().encode(text).length>8192){setError('That message is too long. Keep it under 4,000 characters (fewer with emoji). Nothing was sent.');return;}
  const options=S.apiVersion>=24?chosenChatOptions():undefined,signature=JSON.stringify({text,...(options?{chat_options:options}:{}),...(images.length?{images:images.map(i=>i.length+':'+i.slice(-64))}:{}),...(files.length?{files:files.map(f=>f.name+':'+f.data.length+':'+f.data.slice(-64))}:{})});const token=scope(),id=S.selected,generation=selectionGeneration,epoch=S.epoch;let pending=chatRequests.get(id);if(!pending||pending.signature!==signature){pending={text,signature,options,images,files,key:`pip-chat-${globalThis.crypto.randomUUID()}`};chatRequests.set(id,pending);}S.busy=true;S.error='';
  // Your message is in the chat at once, as in DGC's own chat: the box clears now, not when the reply
  // is queued (a Pip's first step lists its workflow connectors' tools, which can take seconds).
  S.sending={pip:id,text,key:pending.key,at:new Date().toISOString()};chatEdit(()=>{if(draft.chatText.trim()===text)draft.chatText='';render();});
  try{const result=await send('send_pip_message',{pip_id:id,text,idempotency_key:pending.key,...(pending.options?{chat_options:pending.options}:{}),...(pending.images?.length?{images:pending.images}:{}),...(pending.files?.length?{files:pending.files}:{})});if(epoch!==S.epoch)return;if(!record(result.message)||result.message.pip_id!==id||!record(result.run)||result.run.pip_id!==id)throw new Error('The saved message response did not match this Pip. Refresh before retrying.');if(chatRequests.get(id)?.key===pending.key)chatRequests.delete(id);if(chatDrafts.get(id)?.trim()===text)chatDrafts.delete(id);if(pending.images?.length)chatImages.delete(id);if(pending.files?.length)chatFiles.delete(id);rememberView();if(token!==scope()||generation!==selectionGeneration)return;if(draft.chatText.trim()===text)draft.chatText='';await Promise.all([loadMessages(),refresh(false)]);}
  catch(error){if(token===scope()&&generation===selectionGeneration){if(String(errorText(error)).startsWith(CARD_REFUSED)){refuseCard(id);return;}chatEdit(()=>{if(!draft.chatText.trim())draft.chatText=text;setError(error);render();});}}
  finally{if(S.sending?.key===pending.key)S.sending=null;if(token===scope()&&generation===selectionGeneration){S.busy=false;render();$('chatText')?.focus();}}
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
// Usage (API 41): what this Pip's runs cost. Pips have no daily limit (founder, 2026-10-14).
let usageState={pip:'',value:null,loading:false,error:''};
async function loadUsage(){
 const pip=S.selected;if(S.apiVersion<41||!usable()||!pip||usageState.loading&&usageState.pip===pip)return;
 const token=scope();usageState={pip,value:null,loading:true,error:'',token};
 try{const value=pipUsage((await send('get_pip_usage',{pip_id:pip})).usage,pip);if(token!==scope()||S.selected!==pip)return;usageState.value=value;}
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
// The apps this Pip may read (pip_app_links): connected from its chat, taken back here.
function appsMarkup(){
 if(remoteHost||S.apiVersion<43||!personalPip())return '';
 if(appsSettingsPip!==S.selected){appsSettingsPip=S.selected;void loadAppLinks();}
 const connected=(S.appLinks||[]).filter(l=>l.status==='connected'),off=S.busy||!usable()||!!appLinkBusy;
 return `<section class="section" aria-label="Apps"><h2>Apps</h2>${connected.length
  ?`<ul class="app-list">${connected.map(l=>`<li><span><strong>${esc(l.app)}</strong>${l.label?` <small>${esc(l.label)}</small>`:''}</span><button type="button" class="quiet" data-app-link-disconnect="${esc(l.id)}"${off?' disabled':''}>Disconnect</button></li>`).join('')}</ul><p class="muted">It reads these when you ask. Anything it would send or change waits for your Allow. Disconnect stops ${esc(S.pip?.name||'this Pip')} using this account. The account itself stays signed in (in Composio).</p>`
  :`<p class="muted">Nothing connected. Ask ${esc(S.pip?.name||'this Pip')} in its chat to connect an app, like Gmail or Google Calendar.</p>`}</section>`;
}
let appsSettingsPip='';
function grantsMarkup(){
 if(S.apiVersion<41||!S.pip||S.pip.source_policy?.mode!=='personal')return '';
 if(grantsState.pip!==S.selected){void loadGrants();return '';}
 const g=grantsState.value;
 if(!g)return grantsState.error?`<section class="section" aria-label="Allowed without asking"><h2>Allowed without asking</h2>${errorMarkup(grantsState.error)}</section>`:'';
 const off=S.busy||!usable();
 return `<section class="section" aria-label="Allowed without asking"><h2>Allowed without asking</h2>${g.grants.length
   ?`<p class="muted">When ${esc(S.pip?.name||'this Pip')} drafts one of these, it goes ahead without asking and tells you after. Anything else waits for you.</p>${g.grants.map(x=>`<div class="grant-row"><span>${esc(x.label)} <span class="muted">· ${x.account==='connection_managed'?'the account its connection uses':'account '+esc(x.account)}</span></span><button type="button" data-revoke-grant="${esc(x.id)}"${off?' disabled':''}>Stop allowing</button></div>`).join('')}`
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
 const max=Math.max(1,...days.map(e=>e.tokens)),w=14,gap=4,h=40;
 const bars=days.map((e,i)=>{const bh=e.tokens?Math.max(2,Math.round(e.tokens/max*h)):1;return `<rect x="${i*(w+gap)}" y="${h-bh}" width="${w}" height="${bh}" rx="2" class="${e.tokens?'usage-bar':'usage-bar empty'}"><title>${e.day}: ${e.tokens.toLocaleString('en-US')} tokens</title></rect>`;}).join('');
 return `<svg class="usage-chart" viewBox="0 0 ${14*(w+gap)-gap} ${h}" preserveAspectRatio="none" role="img" aria-label="Tokens per day for the last 14 days">${bars}</svg>`;
}
function usageMarkup(){
 if(S.apiVersion<41||!S.pip)return '';
 if(usageState.pip!==S.selected){void loadUsage();return '<section class="section"><h2>Usage</h2><p class="muted">Loading…</p></section>';}
 const u=usageState.value;
 if(!u)return `<section class="section"><h2>Usage</h2>${errorMarkup(usageState.error)||'<p class="muted">Loading…</p>'}</section>`;
 const n=v=>v.toLocaleString('en-US'),runs=v=>`${v} run${v===1?'':'s'}`;
 return `<section id="usage-section" class="section"><h2>Usage</h2><dl class="meta usage-counts"><dt>Today</dt><dd>${n(u.today.tokens)} tokens · ${runs(u.today.runs)}</dd><dt>Last 30 days</dt><dd>${n(u.last_30_days.tokens)} tokens · ${runs(u.last_30_days.runs)}</dd></dl>${usageChart(u)}${errorMarkup(usageState.error)}<p class="muted">What its runs and replies spent, counted on the day each finished. Pips have no daily limit.</p></section>`;
}
Object.assign(draft,{pipsMax:'',pipSearch:''});
// Pips settings: how many Pips you can have (pip_limits; API 44).
document.addEventListener('submit',event=>{if(event.target.id!=='pips-limit-form')return;event.preventDefault();
 const value=Number(draft.pipsMax);if(!Number.isSafeInteger(value)||value<1||value>(pipsSettings.limit?.maximum||100000)){setError(`Choose a number from 1 to ${(pipsSettings.limit?.maximum||100000).toLocaleString('en-US')}.`);return;}
 void mutate({type:'set_pips_limit',max_pips:value},result=>{if(!record(result)||result.max_pips!==value)throw Error('The saved number differs from your choice. Refresh and try again.');pipsSettings.limit=result;draft.pipsMax=String(value);S.notice=`You can have up to ${value.toLocaleString('en-US')} Pips.`;});
});
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
 const m=draft.adaptationMode,words={locked:'It never changes its own setup.',context_adaptive:'It uses notes you shared with it, but never changes its own setup.',suggest_changes:'It may suggest changes to its setup. Each one waits for you.',bounded_adaptive:'It may change only what you tick below, and you can see every change.',autonomous:personalPip()?'It may rename itself. Nothing else.':'It may rename itself and move to a newer commit. Nothing else.'}[m]||'';
 return `<form id="adaptation-form" class="section form"><h2>Changes it may make to itself</h2><label for="adaptationMode" class="sr-only">Changes it may make to itself</label><select id="adaptationMode" data-draft="adaptationMode">${Object.entries(ADAPTATION_MODES).map(([key,label])=>`<option value="${key}"${m===key?' selected':''}>${label}</option>`).join('')}</select><p class="muted">${words} It can never change what it does, when it runs, its model or what it may use.</p>${m==='bounded_adaptive'?`<fieldset><legend>It may change</legend><label class="check-field"><input id="adaptationName" data-draft="adaptationName" type="checkbox"${draft.adaptationName?' checked':''}> Its name</label>${personalPip()?'':`<label class="check-field"><input id="adaptationSource" data-draft="adaptationSource" type="checkbox"${draft.adaptationSource?' checked':''}> The commit it reads</label>`}</fieldset>`:''}${S.adaptationDraftVersion!==S.pip.current_version?'<p class="notice">The Pip changed since you opened this. Reset it and choose again.</p>':''}<div class="actions"><button type="submit" class="primary"${S.busy||!usable()||!S.adaptationDirty?' disabled':''}>Save</button>${S.adaptationDirty?button('reset-adaptation','Reset',S.busy||!usable(),'quiet'):''}</div></form>${adaptationHistoryMarkup()}`;
}
function adaptationHistoryMarkup(){const capped=S.adaptations.length>=200;return `<section class="section" aria-label="Adaptation history"><div class="section-head"><h2>Automatic changes</h2>${button('load-adaptations',S.adaptationsLoading?'Loading…':S.adaptationsLoaded?'Refresh changes':'Load changes',!usable()||S.adaptationsLoading)}</div><p class="muted">Changes it made to itself under the setting above. They didn’t need your OK and didn’t start any work.</p>${errorMarkup(S.adaptationsError)}${S.adaptations.map(a=>`<article class="entry"><h3>${esc(date(a.created_at))}</h3><p>${esc(adaptationLabel(a.policy))}</p><dl class="meta">${Object.entries(a.changes).map(([key,value])=>`<dt>${key==='name'?'Name':'Source ref'}</dt><dd>${esc(value)}</dd>`).join('')}</dl><p class="goal">${esc(a.reason)}</p></article>`).join('')||(S.adaptationsLoaded?'<p class="muted">It hasn’t changed itself.</p>':'')}${S.adaptationCursor&&!capped?button('more-adaptations','Older automatic changes',!usable()||S.adaptationsLoading):''}${capped?'<p class="muted">Showing the latest 200.</p>':''}</section>`;}
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
 try{const p=sourcePin(value);if(p.kind==='personal')return '<dt>Scope</dt><dd>Personal · no project access</dd>';return p.kind==='committed_only'?`<dt>Commit</dt><dd class="mono">${esc(p.revision)}</dd>`:`<dt>Code</dt><dd>Your saved files, copied when it started</dd><dt>Files read</dt><dd>${p.snapshot.files.toLocaleString()} files · ${p.snapshot.bytes.toLocaleString()} bytes</dd><dt>Skipped</dt><dd>${p.snapshot.excluded_entries.toLocaleString()} files · ${p.snapshot.excluded_directories.toLocaleString()} folders</dd><dt>Copy SHA-256</dt><dd class="mono">${esc(p.snapshot.sha256)}</dd>`;}catch{return '<dt>Code</dt><dd>Couldn’t be read</dd>';}
}
function pinnedSourceNotice(value){try{return sourcePin(value).kind==='current_tree'?'<p class="notice">A copy of your saved files at the time, not a commit, skipping files that may hold secrets. Your files may have changed since.</p>':'';}catch{return errorMarkup('Which code it read couldn’t be checked.');}}
function committedJob(pip){try{return sourcePolicy(pip?.source_policy).mode==='committed_only';}catch{return false;}}
function samePinnedSource(a,b){const x=sourcePin(a),y=sourcePin(b);return x.kind===y.kind&&x.revision===y.revision&&(x.snapshot===null?y.snapshot===null:Object.keys(x.snapshot).every(k=>x.snapshot[k]===y.snapshot?.[k]));}
function checkedRunSource(run){draftAutomationPin(run.manifest);if(Object.hasOwn(run.manifest||{},'source_policy')||Object.hasOwn(run.manifest||{},'source_snapshot')){if(run.status==='succeeded')sourceResult(run.manifest,run.result);else sourcePin(run.manifest);}}
function handoffSourceAllowed(value){try{return sourcePin(value).kind==='committed_only';}catch{return false;}}
function hydrateSource(pip){try{const p=sourcePolicy(pip.source_policy);draft.sourceMode=p.mode;sourceExcludeList=[...(p.exclude||[])];}catch{draft.sourceMode='unsupported';sourceExcludeList=[];}draft.sourceExcludeInput='';sourceExcludeProblem='';S.sourceDraftVersion=pip.current_version;}
/** The policy the Source form would save: its source and Excluded folders under the current rules (API 50). */
function draftSourcePolicy(){return sourceWithExcludes({mode:draft.sourceMode,exclusions:'safe_source_v2'},sourceExcludeList);}
function addSourceExclude(){const value=(draft.sourceExcludeInput||'').trim().replace(/^(?:\.\/)+/,'');if(!value)return true;const why=sourceExcludeError(value);if(why){sourceExcludeProblem=why;return false;}if(sourceExcludeList.length>=MAX_SOURCE_EXCLUDES&&!sourceExcludeList.includes(value)){sourceExcludeProblem='A Pip leaves out at most 32 folders or patterns.';return false;}if(!sourceExcludeList.includes(value))sourceExcludeList.push(value);draft.sourceExcludeInput='';sourceExcludeProblem='';S.sourceDirty=true;return true;}
function sourceRulesMarkup(p){
 const off=S.busy||!usable(),tree=draft.sourceMode==='current_tree';let older=false;try{older=sourceRules(p.source_policy)==='safe_source_v1';}catch{/* shown as not supported above */}
 return (older?'<p class="notice">This Pip uses the older source rules: one file over 4 MiB, a link or more than 64 MiB of code fails every run. Saving here moves it to the current rules, which skip those files and list them with each run, and copy up to 256 MiB.</p>':'')
  +`<h3>Excluded folders</h3><p class="muted">Folders or patterns its copy leaves out, written as in a .gitignore file: uploads/, docs/screenshots/, *.mp4. It also leaves out what ${tree?'the project’s .gitignore and .dgcignore files list':'a committed .dgcignore lists'}, files over 4 MiB and links, and each run lists them.</p>`
  +(sourceExcludeList.length?`<ul class="source-excludes">${sourceExcludeList.map((item,i)=>`<li><code>${esc(item)}</code> <button type="button" class="quiet" data-remove-source-exclude="${i}" aria-label="Stop leaving out ${esc(item)}"${off?' disabled':''}>Remove</button></li>`).join('')}</ul>`:'<p class="muted">None yet.</p>')
  +`<label for="sourceExcludeInput">Leave out</label><div class="source-exclude-add"><input id="sourceExcludeInput" data-draft="sourceExcludeInput" value="${esc(draft.sourceExcludeInput||'')}" placeholder="uploads/" maxlength="200" autocomplete="off"${off?' disabled':''}>${button('add-source-exclude','Add',off||sourceExcludeList.length>=MAX_SOURCE_EXCLUDES)}</div>${sourceExcludeProblem?`<p class="error" role="alert">${esc(sourceExcludeProblem)}</p>`:''}`
  +`<div class="actions">${button('check-source','Check size',off||sourceCheckState.loading,'quiet')}</div>${sourceCheckMarkup()}`;
}
function sourceCheckMarkup(){
 const c=sourceCheckState;if(c.pip!==S.selected)return '';
 if(c.loading)return '<p class="muted" role="status">Checking the size…</p>';
 if(c.error)return errorMarkup(c.error);
 const v=c.value;if(!v||!v.applies)return '';
 const folders=v.biggest_folders.length?`<p class="muted">Biggest folders: ${v.biggest_folders.map(f=>esc(f.path)+' '+esc(sizeText(f.bytes))).join(', ')}</p>`:'';
 if(!v.fits)return `<div class="source-check" role="alert"><p class="error">${esc(v.message||'This source doesn’t fit a run.')}</p>${folders}</div>`;
 const left=v.left_out?leftOutLines(v.left_out):[];
 return `<div class="source-check" role="status"><p>Fits: ${v.files.toLocaleString()} files, ${esc(sizeText(v.bytes))} of the ${esc(sizeText(v.limits.bytes))} a run can copy.</p>${left.length?`<p class="muted">Each run leaves out:</p><ul>${left.map(l=>`<li>${esc(l)}</li>`).join('')}</ul>`:''}${folders}</div>`;
}
async function checkSource(){
 if(S.apiVersion<50||!S.pip||personalPip())return;const pip=S.pip.id,token=scope();
 let policy=null;try{if(draft.sourceMode!=='unsupported')policy=draftSourcePolicy();}catch(error){sourceCheckState={pip,value:null,loading:false,error:errorText(error)};render();return;}
 sourceCheckState={pip,value:null,loading:true,error:''};render();
 try{const answer=await send('check_pip_source',{pip_id:pip,...(policy?{source_policy:policy}:{})});if(token!==scope()||S.selected!==pip)return;if(!record(answer)||answer.pip_id!==pip)throw new Error('The size check is for another Pip.');sourceCheckState={pip,value:sourceCheck(answer.check),loading:false,error:''};}
 catch(error){if(token===scope())sourceCheckState={pip,value:null,loading:false,error:errorText(error)};}
 finally{if(token===scope())render();}
}
async function loadRunSource(id){
 if(S.apiVersion<50||personalPip())return;if(runSourceState.run===id&&runSourceState.value?.status==='recorded')return;const token=scope();
 try{const answer=await send('get_pip_run_source',{run_id:id});if(token!==scope()||S.runId!==id)return;if(!record(answer)||answer.run_id!==id||typeof answer.status!=='string')throw new Error('The run’s source record is for another run.');if(answer.left_out!=null)sourceLeftOut(answer.left_out);runSourceState={run:id,value:answer,error:''};}
 catch(error){if(token===scope())runSourceState={run:id,value:null,error:errorText(error)};}
 if(token===scope())render();
}
function runSourceMarkup(run){
 if(S.apiVersion<50||personalPip())return '';const r=runSourceState;if(r.run!==run.id)return '';
 if(r.error)return errorMarkup(r.error);
 const v=r.value;if(!v||v.status!=='recorded'||!v.left_out)return '';const lines=leftOutLines(v.left_out);if(!lines.length)return '';
 return `<details class="source-left-out" data-details="run-left-out"><summary>Left out of this run’s copy (${lines.length})</summary><ul>${lines.map(l=>`<li>${esc(l)}</li>`).join('')}</ul><p class="muted">These are in the project but not in the copy it read, and the Pip was told so.</p></details>`;
}
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
 return `<h3>Web pages</h3>${plan?`<ul class="web-reads">${plan.reads.map(r=>`<li>${esc(webReadLabel(r))}</li>`).join('')}</ul>`:'<p class="muted">None yet.</p>'}${old?'<p class="muted">Update DGC to add web reads.</p>':`<form id="web-reads-form" class="form"><label for="webReads"><span>Pages it reads before each run: up to four, one per line. A web address, or <code>search:</code> and what to look up.</span></label><textarea id="webReads" data-draft="webReads" rows="4" placeholder="https://example.com/status&#10;search: weather in Pune today"${S.busy||!usable()||remoteHost?' disabled':''}>${esc(draft.webReads||webReadsLines(plan))}</textarea><p class="muted">${S.pip?.computer_plan?'Its computer can open other pages too; anything it would submit waits for you.':'It reads only these. It cannot open other pages, sign in or fill in forms.'}</p><div class="actions"><button type="submit"${S.busy||!usable()||remoteHost?' disabled':''}>Save pages…</button>${plan?button('remove-web-reads','Remove all…',S.busy||!usable(),'quiet'):''}</div></form>`}`;
}
// Pip computers (Pips API 42): a Personal Pip's own browser and files. One switch gives it; the
// user can open the browser and drive it (to sign in); what the Pip would submit waits for Send once.
let computerState={pip:'',value:null,loading:false,error:''},computerViewTimer=null;
// Whether this machine is still setting a Pip computer up (DGC downloading its desktop the first time;
// asking starts it). Until it is ready the header says "Setting up your Pip…" instead of offering the
// computer (the founder: "once downloaded, only then the personal computer icon appears").
let screenSetup={pip:'',value:null,loading:false},screenSetupPoll=null;
async function loadDesktopStatus(){
 const pip=S.selected;
 if(S.apiVersion<43||remoteHost||!usable()||!pip||!personalPip()||screenSetup.loading&&screenSetup.pip===pip)return;
 const token=scope();screenSetup={pip,value:screenSetup.pip===pip?screenSetup.value:null,loading:true};
 let value=null;
 try{value=pipComputerDesktop((await send('get_pip_computer_desktop',{pip_id:pip})).desktop,pip);}catch{value=null;}
 if(token!==scope()||S.selected!==pip)return;
 screenSetup={pip,value,loading:false};
 clearTimeout(screenSetupPoll);screenSetupPoll=null;
 if(settingUpComputer())screenSetupPoll=setTimeout(()=>{screenSetupPoll=null;void loadDesktopStatus();},2000);
 render();
}
function settingUpComputer(){
 const d=screenSetup.pip===S.selected?screenSetup.value:null;
 return !!d&&d.available===false&&d.setup?.state==='running';
}
async function loadComputer(){
 const pip=S.selected;if(S.apiVersion<42||!usable()||!pip||computerState.loading&&computerState.pip===pip)return;
 const token=scope();computerState={pip,value:null,loading:true,error:''};
 try{const value=pipComputer((await send('get_pip_computer',{pip_id:pip})).computer,pip);if(token!==scope()||S.selected!==pip)return;computerState.value=value;}
 catch(error){if(token===scope()&&S.selected===pip)computerState.error=errorText(error);}
 finally{if(token===scope()&&S.selected===pip){computerState.loading=false;render();}}
}
// While the chat is open, look again quietly (no blank button while it loads): a run may have hit a
// site's robot check, and the chat should say so at once.
async function refreshComputer(){
 const pip=S.selected;if(S.apiVersion<43||!personalPip()||!usable()||computerState.loading)return;
 if(computerState.pip!==pip){void loadComputer();return;}
 if(!computerState.value?.granted)return;
 // What it needs from you: a robot check, and what its computer holds (shown under its reply).
 const needs=v=>JSON.stringify([v?.needs_you||null,(v?.actions||[]).filter(a=>a.status==='pending').map(a=>a.id)]);
 const token=scope(),before=needs(computerState.value);
 try{const value=pipComputer((await send('get_pip_computer',{pip_id:pip})).computer,pip);if(token!==scope()||S.selected!==pip||computerState.pip!==pip)return;
  computerState.value=value;if(needs(value)!==before)render();}
 catch{/* the next look tries again */}
}
// What its computer holds, under its reply: the decision the computer tab offers, so a user who never opens that tab
// still sees it. A reply that said "Starting with the hospital bill on its pay page" sat above nothing while "Let Bill
// Payer visit…?" waited only in the tab (three-asks test, 2026-10-20). A site: Allow / Not now here; a form or a payment:
// Review… (the screenshot and every field, then Send once) or Reject.
const LEVEL_ASKS={payment:'It looks like a payment, so it asks at every level.',consequential:'Its level asks before this.',unsure:'DGC can’t tell what this does, so it asks.'};
function computerWaitingCards(){
 const c=computerState.pip===S.selected?computerState.value:null;if(!c||S.apiVersion<43||remoteHost)return '';
 const waiting=(Array.isArray(c.actions)?c.actions:[]).filter(a=>a.status==='pending').slice(0,3);if(!waiting.length)return '';
 const name=S.pip?.name||'The Pip',off=S.busy||!usable()||archived()?' disabled':'';
 return waiting.map(a=>{
  const s=a.summary||{},words=carefulWords(s,name),pay=s.payment===true;
  // API 58: why its level still asks (a payment asks at every level; Approve for me asks before an order, a post...).
  const because=LEVEL_ASKS[s.asks_because]||'';
  const title=words?words[0]:pay||s.asks_because==='payment'?`Pay on ${s.host}?`:`Send a form to ${s.host}?`;
  const line=words?words[1]:[sendsWords(s),pay?'It sends payment card details.':'',because,'Nothing has been sent.'].filter(Boolean).join(' ');
  const yes=s.kind==='login'?`<button type="button" class="primary" data-login-card="${esc(a.id)}"${off}>${esc(words[2])}</button>`
   :words?`<button type="button" class="primary" data-computer-decide="${esc(a.id)}" data-approve="1"${off}>${esc(words[2])}</button>`
   :`<button type="button" class="primary" data-computer-action="${esc(a.id)}"${off}>Review…</button>`;
  return `<div class="app-link" data-state="waiting" data-computer-card="${esc(a.id)}" role="group" aria-label="${esc(title)}"><div class="app-link-head"><span class="app-link-mark" aria-hidden="true">!</span><div class="app-link-words"><strong>${esc(title)}</strong><small>${esc(line)}</small></div></div><div class="app-link-actions">${yes}<button type="button" class="quiet" data-computer-decide="${esc(a.id)}" data-approve="0"${off}>${words?'Not now':'Reject'}</button></div></div>`;
 }).join('');
}
async function decideInChat(id,approve){
 const pip=S.selected,a=computerState.pip===pip?computerState.value?.actions?.find(x=>x.id===id):null;if(!a||S.busy||!usable())return;
 const token=scope(),careful=Boolean(carefulWords(a.summary||{},''));S.busy=true;render();
 try{
  const done=pipComputerAction((await send('decide_pip_computer_action',{action_id:a.id,expected_digest:a.digest,approve})).action,pip);
  if(token!==scope())return;if(done.id!==a.id||done.status!==(approve?'approved':'rejected'))throw Error('The saved decision differs from your choice. Refresh to see it.');
  S.notice=!approve?(a.summary?.kind==='login'?`Not now. ${S.pip?.name||'It'} won’t ask to save a login for ${a.summary.site||'that site'} again today.`:careful?'Not now. It won’t do that.':'Rejected. Nothing was sent.'):'Allowed. It opens the site and carries on.';
  computerState.value={...computerState.value,actions:computerState.value.actions.map(x=>x.id===a.id?done:x)};
 }catch(error){if(token===scope())setError(error);}
 finally{if(token===scope()){S.busy=false;render();void refreshComputer();}}
}
// A message with a card number (pipCards.js here, dgc/cards.py in DGC): refused, in one line, with the way to its
// screen. Nothing of it is sent or kept, the draft included.
const CARD_REFUSED='Card numbers stay out of the chat.';
let cardRefused='';
function refuseCard(pip){
 // Out of the box, the saved draft and the undo history: Ctrl+Z must not bring the card back.
 draft.chatText='';const box=$('chatText');if(box)box.value='';chatHistory?.reset();chatDrafts.delete(pip);chatRequests.delete(pip);rememberView();
 cardRefused=pip;S.error='';render();
}
function cardRefusedCard(){
 if(!cardRefused||cardRefused!==S.selected)return '';
 const name=esc(S.pip?.name||'this Pip'),open=computerState.pip===S.selected&&computerState.value?.granted;
 return `<div class="app-link" data-state="needs" data-card-refused="1" role="group" aria-label="${CARD_REFUSED}"><div class="app-link-head"><span class="app-link-mark" aria-hidden="true">!</span><div class="app-link-words"><strong>${CARD_REFUSED}</strong><small>Type it on ${name}’s screen instead. Nothing you typed was sent or kept.</small></div></div><div class="app-link-actions">${open?`<button type="button" class="primary" data-card-open="1">Open its computer</button>`:''}<button type="button" class="quiet" data-card-dismiss="1">OK</button></div></div>`;
}
// A site asked a person to prove they are not a robot: the Pip stopped; the user finishes it on its screen.
function needsYouCard(){
 const n=computerState.pip===S.selected?computerState.value?.needs_you:null;if(!n||S.apiVersion<43)return '';
 const name=esc(S.pip?.name||'This Pip');
 return `<div class="app-link" data-state="needs" role="group" aria-label="${name} needs you"><div class="app-link-head"><span class="app-link-mark" aria-hidden="true">!</span><div class="app-link-words"><strong>${name} needs you</strong><small>${esc(n.host)} wants to check you’re not a robot. Finish it on ${name}’s computer; ${name} carries on after.</small></div></div><div class="app-link-actions"><button type="button" class="primary" data-needs-open="1"${archived()?' disabled':''}>Open its computer</button><button type="button" class="quiet" data-needs-done="1"${S.busy?' disabled':''}>I’ve done it</button></div></div>`;
}
async function finishedCheck(){
 const pip=S.selected;if(!usable()||!pip||S.busy)return;
 void mutate({type:'finish_pip_computer_check',pip_id:pip},()=>{if(computerState.pip===pip&&computerState.value){const {needs_you:_n,...rest}=computerState.value;computerState.value=rest;}S.notice=`${S.pip?.name||'The Pip'} is carrying on.`;void loadMessages();});
}
function computerMarkup(){const inner=computerInner();return inner&&`<div class="computer">${inner}</div>`;}
function computerInner(){
 if(S.apiVersion<42||!personalPip()||remoteHost)return '';
 if(computerState.pip!==S.selected){void loadComputer();return '<h3>Computer</h3><p class="muted">Loading…</p>';}
 const c=computerState.value,off=S.busy||!usable()||archived();
 if(!c)return `<h3>Computer</h3>${errorMarkup(computerState.error)||'<p class="muted">Loading…</p>'}`;
 if(!c.granted)return `<h3>Computer</h3><p class="muted">Give ${esc(S.pip.name)} its own computer, separate from yours: a browser, a Terminal and files, so it can look things up and fill in forms for you.</p>${c.available?button('give-computer','Give this Pip a computer…',off):`<p class="muted">${esc(c.reason)}</p>`}`;
 const waiting=c.actions.filter(a=>a.status==='pending');
 return `<h3>Computer</h3><p>${esc(S.pip.name)} has its own computer: ${S.apiVersion>=54?'a desktop with a browser, an image editor, documents, a PDF viewer, a Terminal and files, online to public websites':'a browser, a Terminal and files, online to public websites'}. Anything its browser would submit waits for you here.</p>${c.available?'':`<p class="notice">${esc(c.reason)}</p>`}<div class="actions">${button('open-computer',S.apiVersion>=43&&!remoteHost?'Open its computer':'Open browser',off||!c.available)}${button('stop-computer','Stop computer',off)}${button('remove-computer','Remove computer…',off)}</div>${waiting.length?`<h4>Waiting for you</h4>${waiting.map(a=>`<article class="computer-action"><div><strong>${carefulWords(a.summary,S.pip.name)?esc(carefulWords(a.summary,S.pip.name)[0]):`${esc(a.summary.method)} ${esc(a.summary.host)}${esc(a.summary.path)}`}</strong><span class="muted">from ${esc(a.summary.page)}</span></div>${`<button type="button" data-computer-action="${esc(a.id)}"${off?' disabled':''}>Review…</button>`}</article>`).join('')}`:''}`;
}
function grantComputer(give){
 const name=S.pip?.name||'this Pip';
 openReview({computerGrant:give,title:give?`Give ${name} a computer?`:`Remove ${name}'s computer?`,
  description:give?'It gets its own computer, separate from yours: a browser, a Terminal and files.':'The Pip will no longer browse. Its saved sign-ins stay on this computer until you remove them.',
  body:give?'<ul class="computer-rules"><li>'+(S.apiVersion>=54?'It can browse public websites, and its Terminal and apps can reach them too.':'It can browse public websites, and its Terminal can reach them too.')+'</li><li>It can still read the apps you connected. Careful mode (on unless you turn it off on its page) asks before it opens a new site, and before anything it read from your apps goes onto a website.</li><li>You sign in yourself with Open its computer; it never sees your passwords.</li><li>It can’t reach this computer or your home network.</li><li>Anything that would submit, send, pay or change something waits for your OK, with a screenshot.</li></ul>':'',
  confirm:give?'Give computer':'Remove computer',request:{type:'propose_pip_update'}});
}
async function applyComputerGrant(review){
 if(S.busy||!usable())return;const pip=S.pip,token=scope();S.busy=true;renderReview();
 try{
  const proposal=(await send('propose_pip_update',{pip_id:pip.id,expected_version:pip.current_version,changes:{computer_plan:review.computerGrant?{schema_version:1}:null},reason:review.computerGrant?'Give this Pip a computer.':'Remove this Pip\'s computer.'})).proposal;
  if(token!==scope())return;
  if(!record(proposal)||proposal.pip_id!==pip.id||JSON.stringify(proposal.definition?.computer_plan??null)!==JSON.stringify(review.computerGrant?{schema_version:1}:null))throw Error('The saved change differs from your choice. Refresh and try again.');
  await send('accept_pip_update',{pip_id:pip.id,proposal_id:proposal.id,expected_version:pip.current_version});
  if(token!==scope())return;closeReview();computerState.pip='';S.notice=review.computerGrant?`${pip.name} has a computer. Use ${S.apiVersion>=43&&!remoteHost?'Open its computer':'Open browser'} to sign in to the sites it needs.`:`${pip.name}'s computer was removed.`;await refresh(true);
 }catch(error){if(token===scope()&&S.review===review)review.error=errorText(error);}
 finally{if(token===scope()){S.busy=false;render();if(S.review)renderReview();}}
}
async function openComputerAction(id){
 const c=computerState.value,a=c?.actions.find(x=>x.id===id);if(!a||!usable())return;
 if(a.summary?.kind==='login'){openLoginForm(a);return;}
 let image='';
 if(a.frame&&a.run_id){try{image=pipComputerFrame(await send('get_pip_computer_frame',{run_id:a.run_id,frame:a.frame}),a.run_id,a.frame).image;}catch{image='';}}
 const s=a.summary,rows=s.fields.map(f=>`<dt>${esc(f.name)}</dt><dd>${esc(f.value)}</dd>`).join(''),words=carefulWords(s,S.pip?.name||'The Pip');
 if(words){
  // Careful mode held it before anything happened: allow the site, or this one carrying of app data.
  openReview({title:words[0],description:words[1],
   body:`${image?`<img class="computer-shot" alt="The page as the Pip left it" src="${image}">`:''}<dl class="meta">${s.kind==='site'?`<dt>Site</dt><dd>${esc(s.shown||s.site||s.host)}</dd><dt>Address</dt><dd>${esc(s.host)}${esc(s.path)}</dd>`:`<dt>Goes onto</dt><dd>${esc(s.host)}${esc(s.path)}</dd>`}${s.page?`<dt>From page</dt><dd>${esc(s.page)}</dd>`:''}</dl>${s.kind==='text'?`<p class="muted">Exactly this, all of it:</p><pre class="message-review-body">${esc(typeof s.text==='string'?s.text:s.fields.map(f=>f.value).join('\n'))}</pre>`:''}`,
   secondary:{id:'reject-computer-action',label:'Not now'},confirm:words[2],always:false,expiresAt:a.expires_at,computerAction:a.id,carefulKind:s.kind,
   request:{type:'decide_pip_computer_action',action_id:a.id,expected_digest:a.digest,approve:true}});
  return;
 }
 openReview({title:'Send this once?',description:`${S.pip?.name||'The Pip'} wants to send a form to ${s.host}. Nothing has been sent.`,
  body:`${image?`<img class="computer-shot" alt="The page as the Pip left it" src="${image}">`:''}<dl class="meta"><dt>Sends to</dt><dd>${esc(s.host)}${esc(s.path)}</dd><dt>From page</dt><dd>${esc(s.page)}</dd>${rows}</dl>${s.more_fields?`<p class="muted">And ${s.more_fields} more fields.</p>`:''}${s.payment===true?'<p class="notice">This sends payment card details.</p>':''}<p class="muted">Sent exactly as shown, once. Values marked ••• are hidden here but will be sent.</p>`,secondary:{id:'reject-computer-action',label:'Reject'},
  confirm:'Send once',always:s.payment!==true,expiresAt:a.expires_at,computerAction:a.id,request:{type:'decide_pip_computer_action',action_id:a.id,expected_digest:a.digest,approve:true}});
}
async function decideComputerAction(review,approve){
 if(S.busy||!usable())return;const token=scope();S.busy=true;renderReview();
 try{
  const q=review.request,a=pipComputerAction((await send('decide_pip_computer_action',{action_id:q.action_id,expected_digest:q.expected_digest,approve})).action,S.selected);
  if(token!==scope())return;if(a.id!==q.action_id||a.status!==(approve?'approved':'rejected'))throw Error('The saved decision differs from your choice. Refresh to see it.');
  closeReview();S.notice=!approve?(review.carefulKind?'Not now. It won’t do that.':'Rejected. Nothing was sent.'):review.carefulKind==='site'?'Allowed. It opens the site and carries on.':review.carefulKind==='text'?'Allowed once. It carries on.':'Approved. It is sent within a few seconds, exactly as shown, and the Pip carries on.';computerState.pip='';render();
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
 // API 43: the computer opens as an editor tab with its Browser, Files and Terminal.
 if(S.apiVersion>=43&&!remoteHost&&S.pip&&S.pip.id===S.selected){vscode.postMessage({type:'pipsOpenComputer',pip:{id:S.pip.id,name:S.pip.name,pip_type:S.pip.pip_type}});return;}
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
// Where a step acted by position, drawn over its screenshot: the Pip's cursor, and for a drag the path it took.
function timelineCursor(img,value){
 const svg=$('computer-timeline-cursor'),p=value?pipComputerPointer(value):null;if(!svg)return;
 const w=img.naturalWidth,h=img.naturalHeight;
 if(!p||!w||!h){svg.setAttribute('hidden','');svg.innerHTML='';return;}
 svg.setAttribute('viewBox',`0 0 ${w} ${h}`);svg.setAttribute('preserveAspectRatio','none');svg.removeAttribute('hidden');
 // The same size on screen however small the screenshot is drawn: k is the image's pixels per screen pixel.
 const k=Math.max(1,w/Math.max(1,img.clientWidth||w)),r=n=>Math.round(n*k*10)/10;
 const path=p.kind==='drag'&&p.from_x!==undefined?`<line class="ct-path" x1="${p.from_x}" y1="${p.from_y}" x2="${p.x}" y2="${p.y}" stroke-width="${r(3)}" stroke-dasharray="${r(8)} ${r(6)}"/><circle class="ct-from" cx="${p.from_x}" cy="${p.from_y}" r="${r(5)}"/>`:'';
 svg.innerHTML=`${path}<circle class="ct-ring" cx="${p.x}" cy="${p.y}" r="${r(13)}" stroke-width="${r(3)}"/><path class="ct-arrow" transform="translate(${p.x} ${p.y}) scale(${r(1)})" d="M0 0 L0 20 L5 15 L9 24 L12 22.5 L8 14 L15 14 Z"/>`;
}
// A run's timeline: the screenshots its computer kept, one at a time.
let computerTimeline=null;
function computerUsedMarkup(run){
 const c=run.result?.computer;if(S.apiVersion<42||remoteHost||!record(c)||!Number.isSafeInteger(c.calls)||!Array.isArray(c.held))return '';
 return `<p class="muted">Used its computer: ${c.calls} ${c.calls===1?'step':'steps'}${c.held.length?` · ${c.held.length} waiting for you in Settings`:''}.</p>${c.calls?`<div class="actions">${button('computer-timeline','What it saw…',S.busy)}</div>`:''}`;
}
async function openComputerTimeline(){
 const run=S.run;if(!run||!usable())return;const token=scope();computerTimeline=null;
 openReview({computerTimeline:true,readOnly:true,title:'What it saw',description:'Screenshots from this run, oldest first. What they show came from websites.',
  body:`<p id="computer-timeline-status" class="muted" role="status">Loading…</p><div class="computer-timeline-frame"><img id="computer-timeline-img" class="computer-shot computer-timeline-shot" alt=""><svg id="computer-timeline-cursor" class="computer-timeline-cursor" aria-hidden="true" hidden></svg></div><p id="computer-timeline-label" class="muted"></p><div class="actions">${button('computer-prev','Previous',true)}${button('computer-next','Next',true)}</div>`,
  request:{type:'list_pip_computer_frames'}});
 try{
  // API 53: each step that acted by position says where, and the screenshot shows its cursor there.
  const v=pipComputerFrames(await send('list_pip_computer_frames',{run_id:run.id,...(S.apiVersion>=53?{pointers:true}:{})}),run.id);
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
 try{const v=pipComputerFrame(await send('get_pip_computer_frame',{run_id:t.run,frame:f.frame}),t.run,f.frame);if(computerTimeline===t&&t.index===i&&S.review?.computerTimeline){const img=$('computer-timeline-img');img.onload=()=>timelineCursor(img,f.pointer);img.src=v.image;img.alt=`Screenshot ${i+1}: ${f.label}`;timelineCursor(img,f.pointer);}}
 catch(error){if(computerTimeline===t)$('computer-timeline-status').textContent=errorText(error);}
}
// API 43: a Personal Pip uses your DGC skills that fit everyday work; you turn them on or off in DGC.
function skillsMarkup(){
 if(S.apiVersion<43||remoteHost)return '';
 return `<h3>Skills</h3><p>Uses your DGC skills that fit everyday work: deep research, charts and planning, and the ones you add. A skill is instructions; it never gives the Pip new access.</p><div class="actions">${button('manage-skills','Manage skills…',false,'quiet')}</div>`;
}
function sourceSettingsMarkup(){
  if(!personalPip())return '';
  const off=S.busy||!usable();
  return `<section class="section"><h2>What it can use</h2>${computerMarkup()}${webReadsMarkup()}${S.apiVersion>=43&&!S.pip.app_plan?'':`<h3>${S.apiVersion>=43?'Reads before each task':'Connected apps'}</h3>${S.pip.app_plan?`<p>Before each task it reads:</p>${readList(S.pip.app_plan)}`:'<p class="muted">None yet. Connect an app once in DGC Settings, then choose it here.</p>'}<div class="actions">${button('choose-app-access',S.pip.app_plan?'Change…':'Choose an account…',off||S.apiVersion<29||remoteHost)}${S.apiVersion>=43?'':button('setup-apps','Set up in chat',off,'quiet')}${S.pip.app_plan?button('remove-app-access','Remove…',off,'quiet'):''}</div>`}${canReviewMessages()||!remoteHost&&S.apiVersion>=32?`<p class="drafts-links"><span class="muted">What it prepared:</span>${canReviewMessages()?button('message-reviews','Actions',S.busy,'link'):''}${!remoteHost&&S.apiVersion>=32?button('email-drafts','Emails',S.busy,'link'):''}${!remoteHost&&S.apiVersion>=35?button('calendar-drafts','Calendar events',S.busy,'link'):''}${!remoteHost&&S.apiVersion>=37?button('connector-drafts','App actions',S.busy,'link'):''}</p>`:''}${skillsMarkup()}</section>`;
}
function projectSourceMarkup(){
 const p=S.pip;if(S.apiVersion<11)return '<section class="section"><h2>Source</h2><p class="muted">'+esc(sourcePolicyLabel(p.source_policy))+'. Update DGC to change it.</p></section>';
 if(!['scout','lens','rook','lock','quill'].includes(p.pip_type??'rook'))return '<section class="section"><h2>Source</h2><p class="muted">Committed code only. Patch and Pulse always work from a commit, and you approve what they may change or run each time.</p></section>';
 return `<form id="source-form" class="section form"><h2>Source</h2><p class="muted">Now: ${esc(sourcePolicyLabel(p.source_policy))}. Work already started keeps the code it started with.</p><label for="sourceMode">Code it reads from now on</label><select id="sourceMode" data-draft="sourceMode"><option value="committed_only"${draft.sourceMode==='committed_only'?' selected':''}>Committed code</option><option value="current_tree"${draft.sourceMode==='current_tree'?' selected':''}>Your current files · only when you ask</option>${draft.sourceMode==='unsupported'?'<option value="unsupported" selected>Not supported here</option>':''}</select>${draft.sourceMode==='current_tree'?'<p class="notice">Each time you ask, it copies your saved files (not unsaved edits, and skipping files that may hold secrets) and reads the copy. Your files aren’t changed.</p><p class="muted">This turns off its schedule and event triggers, and it can’t take part in handoffs. Its branch setting stays as it is until you switch back.</p>':'<p class="muted">It reads committed code from its branch or commit. Uncommitted changes aren’t included. Switching back doesn’t bring back a schedule or triggers; set them again in Schedule.</p>'}${S.apiVersion>=50&&draft.sourceMode!=='unsupported'?sourceRulesMarkup(p):''}<button type="submit" class="primary"${S.busy||!usable()?' disabled':''}>Save</button>${S.sourceDraftVersion!==p.current_version?'<p class="notice">This Pip changed while you edited this. Reset and choose again.</p>':''}<div class="actions">${button('reset-source','Reset',S.busy||!usable())}</div></form>`;
}
function lifecycleMarkup(){
 if(S.apiVersion<16)return archived()?'<p class="muted">Update DGC to restore this archived Pip.</p>':'';
 if(!canLifecycle())return '<p class="notice">Refresh, then try again.</p>';
 return `<details data-details="pip-lifecycle"${archived()?' open':''}><summary>${archived()?'Restore archived Pip':'Archive Pip'}</summary><p class="muted">${archived()?'Restore brings it back paused. Nothing runs until you resume it.':'Archiving keeps its chat, reports and history. Work in progress must finish or be stopped first, and handoffs waiting for you must be answered; nothing is cancelled for you.'}</p>${personalPip()?'':`<p class="muted">Version ${S.pip.current_version}</p>`}${button(archived()?'restore-pip':'archive-pip',archived()?'Restore…':'Archive…',S.busy||!usable())}</details>`;
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
   +`<form id="model-form" class="section form"><h2>Model</h2>${modelPicker('pipModel','Model this Pip uses',draft.pipModel,personalPip())}<div class="actions"><button type="submit" class="primary"${off||!S.modelDirty?' disabled':''}>Save model</button></div></form>`
   +appsMarkup()+grantsMarkup()+usageMarkup()
   +`<section class="section"><h2>Pause or archive</h2><p class="muted">${p.status==='paused'?'Paused. It does not run until you resume it.':'Pausing stops it from running. Archiving puts it away; you can restore it later.'}</p><div class="actions">${button('toggle-pip',p.status==='paused'?'Resume':'Pause',off||S.apiVersion>=16&&!canLifecycle())}${S.apiVersion>=16&&canLifecycle()?button('archive-pip','Archive…',off,'quiet danger'):''}</div></section>`
   +`<details class="advanced section" data-details="advanced"><summary>Advanced</summary><p class="muted">Most Pips never need these.</p>${notifyMarkup()}${adaptationMarkup()}${personalPip()?'':projectSourceMarkup()}${shareMarkup()}</details>`;
}
function chooseType(id){const type=S.types.find(t=>t.id===id);if(!S.create||!type?.available||S.busy||!usable())return;rememberCreationDraft();S.createType=id;Object.assign(draft,creationDrafts.get(id)||{name:type.default_name,goal:type.default_goal,source_ref:'HEAD',createModel:'default'});S.createStep='configure';S.error='';render();$('name')?.focus();}
function jobMarkup(p) {
  const type=pipType(p,S.types),pose=presentation(p,[],usable(),S.runner),reviews=pendingReviews(p);
  return `<button type="button" class="job" data-character="${esc(type?.id||'core')}" data-state="${esc(pose.state)}" data-job="${esc(p.id)}" title="${esc(p.name)} · ${esc(pose.label)}" aria-label="${esc(p.name)} · ${esc(pose.label)}" aria-current="${S.selected===p.id&&!S.create}">${pipAvatar(p,pose.state,`row-${p.id}`,type)}<span class="job-copy"><strong>${esc(p.name)}</strong><span class="job-role">${type?`${esc(type.name)} · ${personalPip(p)?(p.pip_type==='core'?'Your Primary Pip, in the main chat’s character':'Personal helper'):livePip(p)&&S.apiVersion>=60?'Live data':esc(type.role)}`:'Unsupported Pip type'}</span><span class="job-goal">${esc(p.goal||type?.description||'')}</span><small class="job-status"><i aria-hidden="true"></i>${esc(pose.label)}</small><span class="job-schedule">${esc(scheduleLabel(p.schedule))}</span>${reviews?`<span class="review-count">${reviews} waiting for you</span>`:''}</span></button>`;
}
function executionMarkup(run) {
  const e=execution(run);
  const rows=items=>items.map(([label,value])=>`<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('');
  return `<section class="execution" aria-label="Run execution"><h3>Details</h3><dl class="meta">${rows([['Model',e.model],...(personalPip()?[]:[['Run ID',run.id],['Access',e.policy==='read_only'?'Read only':e.policy==='review_required'?'Only what you approved':e.policy]]),['Steps',e.calls],['Started',run.started_at?date(run.started_at):'Not recorded'],['Finished',run.finished_at?date(run.finished_at):'Not recorded'],['Waited',e.queueDuration],['Took',e.duration]])}</dl><details data-details="execution-usage"><summary>Tokens used and limits</summary><dl class="meta">${rows(e.usage)}</dl><dl class="meta">${rows(e.limits)}</dl></details><details data-details="execution-policy"><summary>What it was allowed to use</summary>${e.tools===null?'<p class="muted">Allowed tools were not recorded.</p>':e.tools.length?`<ul class="tool-list">${e.tools.map(t=>`<li><code>${esc(t)}</code></li>`).join('')}</ul>`:'<p class="muted">No tools were allowed.</p>'}<p class="muted">Not a record of what it used.</p></details></section>`;
}
function activityMarkup() {
  const a=S.activity,limited=(a?.events.length||0)>=500;
  return `<section class="run-activity" aria-label="Run activity"><div class="section-head"><h3>What it did</h3>${button('load-activity',S.activityLoading?'Loading…':!a?'Load activity':a.has_more?'Load more activity':'Check for new activity',!usable()||S.activityLoading||limited)}</div><p class="muted">${a?`${a.events.length} ${a.events.length===1?'step':'steps'} shown.`:'See each step it took.'}</p>${a?.history_may_be_truncated?'<p class="notice">Some earlier steps may not be kept.</p>':''}${S.activityError?errorMarkup(S.activityError):''}${a?.events.length?`<ol class="activity-list">${a.events.map(event=>`<li><span>${esc(activityLabel(event))}</span><small>${esc(date(event.created_at))}</small></li>`).join('')}</ol>`:a?'<p class="muted">No steps recorded.</p>':''}${a?.has_more&&!limited?'<p class="muted">There are more steps to load.</p>':''}${limited?'<p class="notice">Showing the first 500 steps.</p>':''}</section>`;
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
  return `<section class="section" aria-label="Compared with the last audit"><h3>Compared with the last audit</h3>${errorMarkup(error||baselineError)}<p class="muted">${baselineError?'The earlier audit it compares with couldn’t be read.':checkpoint?.comparison?.status==='unavailable'?(checkpoint.comparison.reason==='source_policy_changed'?'Not compared: the code it reads changed (committed or current files). Earlier findings aren’t counted as fixed.':'Not compared: this is its first audit of this code.'):baseline?prior?'Compared with its previous audit.':'There was no earlier audit to compare with.':'No comparison was saved with this audit.'}</p>${prior?`<dl class="meta">${pinnedSourceMarkup(prior)}<dt>Findings last time</dt><dd>${prior.total_findings}${prior.omitted_findings?` · ${prior.omitted_findings} too long to show the model`:''}</dd></dl>`:''}${checkpoint?`<dl class="meta"><dt>Findings</dt><dd>${checkpoint.counts.total}</dd><dt>New</dt><dd>${checkpoint.counts.new??'Unavailable'}</dd><dt>Found again</dt><dd>${checkpoint.counts.repeated??'Unavailable'}</dd><dt>Not found again</dt><dd>${checkpoint.counts.not_observed??'Unavailable'}</dd></dl><p class="muted">“Not found again” means an earlier finding didn’t come up this time. It doesn’t mean it was fixed.</p>`:!error?'<p class="muted">No comparison was saved with this report.</p>':''}</section>`;
}
function findingReviewMarkup(f,index) {
  const r=f.review,label=status=>({open:'Open',accepted:'Accepted',dismissed:'Dismissed'}[status]);
  return `<div class="finding-review"><p><span class="badge">${f.comparison==='uncompared'?'Not compared':f.comparison==='new'?'New':'Found before'}</span> <span class="badge">${label(r.status)}</span></p>${r.revision?`<p class="muted">Decided ${esc(requester(r.actor))}${r.updated_at?` · ${esc(date(r.updated_at))}`:''}</p>`:''}${r.reason?`<p class="muted">${esc(r.reason)}</p>`:''}<div class="actions">${['accepted','dismissed','open'].filter(status=>status!==r.status).map(status=>`<button type="button" data-review-finding="${index}" data-review-status="${status}"${S.busy||!usable()?' disabled':''}>${status==='accepted'?'Accept finding…':status==='dismissed'?'Dismiss finding…':'Reopen finding…'}</button>`).join('')}</div></div>`;
}
function checkpointHistoryMarkup(){
  const capped=S.checkpoints.length>=200;
  return `<section class="section" aria-label="Past audits"><div class="section-head"><h3>Past audits</h3>${button('load-checkpoints',S.checkpointsLoading?'Loading…':S.checkpointsLoaded?'Refresh':'Load past audits',!usable()||S.checkpointsLoading)}</div><p class="muted">How each finished audit compared with the one before.</p>${errorMarkup(S.checkpointsError)}${S.checkpoints.map(c=>`<article class="checkpoint-row"><button type="button" data-run="${esc(c.run_id)}">Audit · ${esc(date(c.created_at))}</button><p class="muted">${c.counts.total} findings · ${c.comparison?.status==='unavailable'?'Not compared':`${c.counts.new} new · ${c.counts.repeated} found again · ${c.counts.not_observed} not found again`}</p><small>Version ${c.job_version} · ${esc(c.model)}</small></article>`).join('')|| (S.checkpointsLoaded?'<p class="muted">No past audits yet.</p>':'')}${S.checkpointCursor&&!capped?button('more-checkpoints','Older audits',!usable()||S.checkpointsLoading):''}${capped?'<p class="muted">Showing the latest 200.</p>':''}</section>`;
}
async function loadCheckpoints(more=false){
  if(!usable()||!S.selected||S.checkpointsLoading||(more&&(!S.checkpointCursor||S.checkpoints.length>=200)))return;
  const token=scope(),sequence=++checkpointSeq,before=more?S.checkpointCursor:null;S.checkpointsLoading=true;S.checkpointsError='';render();
  try{const page=checkpointsPage(await send('list_pip_checkpoints',{pip_id:S.selected,limit:20,...(before?{before_id:before}:{})}),S.selected,S.workspace.id);if(token!==scope()||sequence!==checkpointSeq)return;
    if(more&&(page.checkpoints.some(c=>c.id>=before||S.checkpoints.some(old=>old.id===c.id))||page.next_before_id===before))throw new Error('Past audits didn’t load. Refresh to try again.');
    S.checkpoints=more?[...S.checkpoints,...page.checkpoints]:page.checkpoints;S.checkpointCursor=page.next_before_id;S.checkpointsLoaded=true;
  }catch(error){if(token===scope()&&sequence===checkpointSeq)S.checkpointsError=errorText(error);}
  finally{if(token===scope()&&sequence===checkpointSeq){S.checkpointsLoading=false;render();}}
}
function handoffTitle(payload){return payload.type==='personal_result.v1'?'Shared result':payload.type==='patch_artifact.v1'?'Accepted Patch changes':payload.source.title;}
function artifactSourceMarkup(source){return `<section aria-label="Accepted Patch changes"><h3>Accepted Patch changes</h3><dl class="meta"><dt>Base commit</dt><dd class="mono">${esc(source.source_revision)}</dd><dt>Your review</dt><dd>Accepted</dd></dl><h3>Changed files</h3><pre>${esc(source.changed_files.join('\n'))}</pre><p class="muted">Pulse tests exactly these changes, applied to a private copy of the base commit. It doesn’t test your current code or change your files.</p><details><summary>Technical details</summary><dl class="meta"><dt>Patch run</dt><dd class="mono">${esc(source.run_id)}</dd><dt>Result fingerprint</dt><dd class="mono">${esc(source.result_digest)}</dd><dt>Saved diff</dt><dd class="mono">${esc(source.artifact.path)} · ${source.artifact.bytes.toLocaleString()} bytes</dd><dt>Diff SHA-256</dt><dd class="mono">${esc(source.artifact.sha256)}</dd></dl></details></section>`;}
function patchSource(run){
  if(run?.status!=='succeeded'||run.manifest?.run_kind!=='patch')return null;
  const review=executionReview(run.execution_review,run.id);if(review?.status!=='accepted')return null;
  const pin=handoffPin(run.manifest.handoff,run,S.workspace.id),result=executionResult(run.result?.execution,'patch',pin.payload.action,pin.payload);
  return patchArtifactSource({pip_id:run.pip_id,run_id:run.id,job_version:run.manifest.job_version,source_revision:run.manifest.source_revision,model:run.manifest.model,result_digest:review.result_digest,review_revision:review.revision,review_status:review.status,artifact:result.changes.artifact,changed_files:result.changes.changed_files});
}
function artifactHandoffControl(run){try{return !archived()&&patchSource(run)?`<section class="section"><h3>Test these changes</h3><p class="muted">Hand them to Pulse with the exact test commands to run. You review the handoff before anything runs; nothing starts on its own.</p>${button('handoff-artifact','Hand to Pulse…',S.busy||!usable())}</section>`:'';}catch{return '';}}
function executionContextControl(run){
  try{const review=executionReview(run.execution_review,run.id);if(review?.status!=='accepted')return '';
  const recorded=S.context?.entries.some(e=>e.kind==='execution'&&e.provenance.run_id===run.id);
  return `<section class="section" aria-label="Save to context"><h3>Workspace context</h3><p class="muted">${recorded?'This outcome is already in context. To save a newer review, archive that record in Context first.':'Save this outcome so future runs in this workspace know about it: which files changed and how each test ended. The model’s conclusions and the command output aren’t included.'}</p>${recorded?'':button('record-execution-context','Save to context…',S.busy||!usable()||!S.context)}</section>`;}catch{return '';}
}
function inputReceiptMarkup(input){return input?`<section class="section" aria-label="What was tested"><h3>What was tested</h3><p class="muted">The accepted Patch changes, applied to the base commit. “Changed files” above lists only what the tests themselves changed.</p><dl class="meta"><dt>Base commit</dt><dd class="mono">${esc(input.source_revision)}</dd></dl><details><summary>Technical details</summary><dl class="meta"><dt>Patch run</dt><dd class="mono">${esc(input.source_run_id)}</dd><dt>Diff SHA-256</dt><dd class="mono">${esc(input.artifact_sha256)}</dd><dt>Tested tree</dt><dd class="mono">${esc(input.tree)}</dd></dl></details></section>`:'';}
function lineageMarkup(run){
  if(!run.manifest?.handoff)return '';
  try{const h=handoffPin(run.manifest.handoff,run,S.workspace.id),p=h.payload;return `<section class="section" aria-label="Where this came from"><h3>Handoff</h3><p>${esc(handoffTitle(p))}</p><p class="goal">${esc(p.task)}</p><dl class="meta"><dt>Approved</dt><dd>${esc(requester(h.review.actor))} · ${esc(date(h.review.approved_at))}</dd></dl><div class="actions"><button type="button" data-lineage-pip="${esc(p.source.pip_id)}" data-lineage-run="${esc(p.source.run_id)}">Open the original report</button><button type="button" data-handoff="${esc(h.handoff_id)}">View handoff</button></div></section>`;}catch(error){return errorMarkup(errorText(error));}
}
function executionReviewMarkup(run){
  try{const r=executionReview(run.execution_review,run.id);if(!r)return '<p class="muted">There’s nothing to review for this run.</p>';
    return `<section class="section" aria-label="Your review"><h3>Your review</h3><p>${r.status==='accepted'?'Accepted':r.status==='dismissed'?'Dismissed':'Not reviewed yet'}</p><p class="muted">Accepting only records your decision. It doesn’t apply, merge or deploy anything.</p>${r.reason?`<p>${esc(r.reason)}</p><p class="muted">${esc(requester(r.actor))} · ${esc(date(r.updated_at))}</p>`:''}<div class="actions">${['accepted','dismissed','open'].filter(status=>status!==r.status).map(status=>`<button type="button" data-execution-review="${status}"${S.busy||!usable()?' disabled':''}>${status==='accepted'?'Accept outcome…':status==='dismissed'?'Dismiss outcome…':'Reopen outcome…'}</button>`).join('')}</div></section>`;
  }catch(error){return errorMarkup(errorText(error));}
}
function executionReportMarkup(run){
  let pin=null,result=null,specialists=null,error='';try{pin=handoffPin(run.manifest.handoff,run,S.workspace.id);specialistPolicy(run.manifest,pin.payload.action);if(run.result)specialists=specialistReceipt(run.result,run.manifest,pin.payload.action);if(run.result?.execution!=null)result=executionResult(run.result.execution,run.manifest.run_kind,pin.payload.action,pin.payload);else if(run.status==='succeeded')throw new Error('This run finished without a result. Don’t assume the changes or tests worked.');}catch(e){error=errorText(e);}
  const artifact=a=>`<details><summary>Saved copy</summary><p class="mono">${esc(a.path)} · ${a.bytes.toLocaleString()} bytes</p><p class="mono">SHA-256 ${esc(a.sha256)}</p></details>`;
  return `<section class="section" aria-label="Execution report"><div class="section-head"><h2>${run.manifest.run_kind==='patch'?'Proposed changes':'Test results'} · ${esc(personalStatusLabel(run.status))}</h2>${active(run.status)?button('cancel-run','Cancel run…',S.busy||!usable(),'danger'):''}</div><dl class="meta">${pinnedSourceMarkup(run.manifest)}</dl>${pinnedSourceNotice(run.manifest)}${executionMarkup(run)}${lineageMarkup(run)}${activityMarkup()}${errorMarkup(error)}${run.status==='failed'?errorMarkup(errorText(run.error)):''}${run.status==='cancelled'?'<p class="notice">Cancelled before it finished. Nothing here is a finished change or test result.</p>':''}${active(run.status)?'<p class="muted" role="status">Working on the handoff. This page updates while it’s open.</p>':''}${result?`<p class="notice">These changes are in a private copy. Nothing was applied to your files, merged or deployed.</p><h3>Changed files (${result.changes.changed_files.length})</h3><pre>${esc(result.changes.changed_files.join('\n')||'No files changed.')}</pre><h3>Diff</h3><pre>${esc(result.changes.diff||'No text changes to show.')}</pre>${result.changes.diff_truncated?'<p class="notice">Only the start of the diff is shown. The saved copy has all of it.</p>':''}${artifact(result.changes.artifact)}${inputReceiptMarkup(result.input)}${specialistReceiptMarkup(specialists)}<h3>Test commands (${result.tests.length} of ${pin.payload.action.tests.length} ran)</h3>${result.tests.map(t=>`<article class="entry"><h3>Command ${t.index+1} · ${esc(outcomeWords(t.status))}</h3><pre>${esc(commandLine(t.argv))}</pre><dl class="meta"><dt>Runs in</dt><dd class="mono">${esc(t.cwd)}</dd><dt>Exit code</dt><dd>${t.exit_code===null?'Not recorded':t.exit_code}</dd></dl><pre>${esc(t.output||'No output recorded.')}</pre>${t.output_truncated?'<p class="notice">Only the start of the output is shown.</p>':''}${artifact(t.artifact)}</article>`).join('')||'<p class="muted">No test results were saved.</p>'}<p class="muted">Exit code 0 means that command succeeded. It doesn’t prove every bug is fixed or that all tests pass.</p>${run.status==='succeeded'?executionReviewMarkup(run)+artifactHandoffControl(run)+executionContextControl(run):''}`:''}</section>`;
}
function draftReportMarkup(run){
  let result=null,error='';try{checkedRunSource(run);if(run.status==='succeeded')result=documentationDraft(run.result);}catch(e){result=null;error=errorText(e);}
  return `<section class="section" aria-label="Documentation draft"><div class="section-head"><h2>${result?esc(result.title):'Documentation draft'} · ${esc(personalStatusLabel(run.status))}</h2>${active(run.status)?button('cancel-run','Cancel draft…',S.busy||!usable(),'danger'):''}</div><dl class="meta">${pinnedSourceMarkup(run.manifest)}</dl>${pinnedSourceNotice(run.manifest)}${runSourceMarkup(run)}${executionMarkup(run)}${draftAutomationMarkup(run.manifest)}${eventReceiptMarkup(run.manifest)}${activityMarkup()}${errorMarkup(error)}${run.status==='failed'?errorMarkup(errorText(run.error)):''}${active(run.status)?'<p role="status" class="muted">Writing the draft from the committed code. Your files aren’t changed.</p>':''}${run.status==='cancelled'?'<p class="notice">Cancelled before the draft was finished.</p>':''}${result?`<p class="notice">A draft written by the model. The quoted code below was checked against the source; the rest wasn’t.</p><p class="goal">${esc(result.summary)}</p><h3>Draft</h3><pre class="documentation-markdown" tabindex="0" aria-label="Draft text">${esc(result.draft.markdown)}</pre><div class="actions">${button('copy-draft','Copy draft',S.busy)}${remoteHost&&options.downloadDraft!==false?button('download-draft','Download Markdown',S.busy):''}</div><p class="muted">Copying or downloading doesn’t publish anything or change your files.</p><h3>Quoted code</h3>${result.draft.citations.map(c=>`<article class="entry"><p class="mono">${esc(c.path)}:${c.line}</p><pre>${esc(c.excerpt)}</pre><p class="muted">Checked against the source.</p></article>`).join('')}<details><summary>Saved copy</summary><p class="mono">${esc(result.draft.artifact.path)} · ${result.draft.artifact.bytes} bytes</p><p class="mono">SHA-256 ${esc(result.draft.artifact.sha256)}</p></details>`:''}</section>`;
}
function draftAutomationMarkup(manifest){
 try{const grant=draftAutomationPin(manifest);if(!grant)return '';return `<section class="section" aria-label="How this draft started"><h3>${grant.trigger==='schedule'?'Scheduled draft':'Started by an event'}</h3><p>${esc(grant.trigger==='schedule'?scheduleLabel(grant.policy):eventTriggerLabel(grant.policy))}</p>${grant.trigger==='schedule'?`<dl class="meta"><dt>Scheduled for</dt><dd>${esc(date(manifest.scheduled_at))}</dd></dl>`:''}<p class="muted">${esc(quillAutomationNotice)}</p><details><summary>Technical details</summary><dl class="meta"><dt>Version</dt><dd>${grant.job_version}</dd><dt>Setup fingerprint</dt><dd class="mono">${esc(grant.definition_digest)}</dd><dt>Job fingerprint</dt><dd class="mono">${esc(grant.job_digest)}</dd><dt>Approval fingerprint</dt><dd class="mono">${esc(grant.digest)}</dd></dl><p class="muted">These identify the approval this draft ran under. They aren’t a new approval.</p></details></section>`;}catch(error){return errorMarkup(errorText(error));}
}
function eventReceiptMarkup(manifest){
 if(manifest?.trigger!=='event')return '';try{const pin=eventRunPin(manifest);return `<section class="section" aria-label="What started this"><h3>${manifest.pip_type==='quill'?'Draft':'Audit'} started by an event</h3><p>${esc(eventTriggerLabel(pin.policy))}</p><dl class="meta"><dt>Event</dt><dd>${esc(eventWords(pin.event))}</dd><dt>When</dt><dd>${esc(date(pin.event.created_at))}</dd><dt>Checked</dt><dd>${esc(date(pin.checked_at))}</dd></dl>${pin.event.event_type==='workspace_session_turn_completed'?`<p class="muted">${esc(sessionTurnNotice)}</p>`:''}<p class="muted">It read the latest commit on its branch when it started, not the commit from the event. The event gives it no new permissions, and its details aren’t passed to the model.</p>${commitMatchMarkup(pin,manifest)}${pin.history_may_be_incomplete?'<p class="notice">Some earlier events may be missing. This isn’t a full history of changes.</p>':''}</section>`;}catch(error){return errorMarkup(errorText(error));}
}
function reportMarkup(){return runReportMarkup()+feedbackMarkup(S.run);}
function runReportMarkup() {
  const run=S.run;
  if(!S.runId) return `<p class="muted">${personalPip()?'Choose a result to see it.':'Choose a run to see its report.'}</p>`;
  if(!run || run.id!==S.runId) return '<p role="status">Loading run…</p>';
  if(run.manifest?.run_kind==='personal_task')return `<section class="section" aria-label="Personal result"><div class="section-head"><h2>${esc(personalStatusLabel(run.status))}</h2>${active(run.status)?button('cancel-run','Stop…',S.busy||!usable(),'danger'):''}</div><p class="muted">Saved with ${esc(S.pip?.name||'this Pip')}. Nothing was sent or changed without your OK.</p>${run.status==='failed'?errorMarkup(errorText(run.error)):''}${run.status==='succeeded'&&typeof run.result?.text==='string'?`<div class="message-body text final personal-result-text" tabindex="0">${renderPipMarkdown(run.result.text)}</div>${run.manifest.handoff?`<p class="muted">Another Pip shared this with it. <button type="button" data-handoff="${esc(run.manifest.handoff.handoff_id)}">See what was shared</button></p>`:''}<div class="actions">${button('copy-personal-result','Copy result',S.busy)}${!remoteHost?button('open-personal-result','Open',S.busy)+button('save-personal-result','Save as file…',S.busy)+(S.apiVersion>=31&&!archived()?button('prepare-message','Prepare email…',S.busy):'')+(S.apiVersion>=34&&!archived()?button('prepare-calendar','Prepare calendar event…',S.busy):'')+(S.apiVersion>=36&&!archived()?button('prepare-connector','Use an app…',S.busy):'')+(S.apiVersion>=30&&!archived()?button('handoff-personal','Share with another Pip…',S.busy):''):''}</div>`:''}${run.status==='succeeded'?computerUsedMarkup(run):''}${activityMarkup()}</section>`;
  if(run.manifest?.run_kind==='conversation')return `<section class="section" aria-label="Conversation run"><h2>Conversation reply</h2><p class="muted">${esc(personalStatusLabel(run.status))}. One of its chat replies.</p>${run.status==='failed'?errorMarkup(errorText(run.error)):''}${run.status==='succeeded'?computerUsedMarkup(run):''}<button type="button" data-tab="chat">Back to chat</button>${executionMarkup(run)}${memoryPinMarkup(run)}</section>`;
  if(run.manifest?.run_kind==='live')return liveReportMarkup(run);
  if(Object.hasOwn(run.manifest||{},'pulse_verification')||run.manifest?.run_kind==='test'&&!run.manifest?.handoff)return pulseReportMarkup(run);
  if(['patch','test'].includes(run.manifest?.run_kind))return executionReportMarkup(run);
  if(run.manifest?.run_kind==='draft')return draftReportMarkup(run);
  let result=report(run.result);const m=record(run.manifest)?run.manifest:{};let sourceError='';if(run.status==='succeeded'){try{checkedRunSource(run);}catch(error){sourceError=errorText(error);result=null;}}let checkpoint=null,checkpointError='';
  try{checkpoint=runCheckpoint(run.checkpoint,{id:run.id,pip_id:S.selected,workspace_id:S.workspace.id});if(checkpoint&&checkpoint.schema_version===2&&!samePinnedSource(checkpoint,m))throw new Error('Checkpoint source does not match this run.');if(checkpoint&&(!result||checkpoint.findings.length!==result.findings.length||checkpoint.findings.some((f,i)=>['title','path','line','evidence'].some(key=>f[key]!==result.findings[i][key]))))throw new Error('Checkpoint findings do not match the saved report.');}catch(error){checkpoint=null;checkpointError=errorText(error);}
  let pinned=null,pinnedInvalid=false;
  if(m.workspace_context!=null){try{pinned=context(m.workspace_context,S.workspace.id);if(typeof pinned.digest!=='string'||!/^[a-f0-9]{64}$/.test(pinned.digest))throw new Error('Invalid digest');}catch{pinned=null;pinnedInvalid=true;}}
  return `<section class="section" aria-label="Run report"><div class="section-head"><h2>${statusLabel(run.status)}</h2>${active(run.status)?button('cancel-run','Cancel run…',S.busy||!usable(),'danger'):''}</div><dl class="meta"><dt>Version</dt><dd>${esc(m.job_version??'Unavailable')}</dd>${pinnedSourceMarkup(m)}<dt>Created</dt><dd>${esc(date(run.created_at))}</dd><dt>Started by</dt><dd>${m.trigger==='schedule'?'Its schedule':m.trigger==='manual'?'You':m.trigger==='handoff'?'A handoff':m.trigger==='event'?'An event':'Not recorded'}</dd>${m.trigger==='schedule'?`<dt>Scheduled for</dt><dd>${esc(date(m.scheduled_at))}</dd>`:''}<dt>Context</dt><dd>${pinned?`${pinned.entries.length} ${pinned.entries.length===1?'record':'records'}`:pinnedInvalid?'Couldn’t be read':'Not recorded'}</dd></dl>${executionMarkup(run)}${lineageMarkup(run)}${pinnedSourceNotice(m)}${runSourceMarkup(run)}${errorMarkup(sourceError)}${eventReceiptMarkup(m)}${memoryPinMarkup(run)}${checkpointReportMarkup(run,checkpoint,checkpointError)}${activityMarkup()}${pinnedInvalid?errorMarkup('The context saved with this run couldn’t be read.'):''}${pinned?`<details data-details="pinned"><summary>Context used by this run</summary>${contextEntries(pinned.entries)}</details>`:''}${run.status==='failed'?errorMarkup(errorText(run.error)):''}${run.status==='cancelled'?'<p class="notice">Cancelled before the audit finished.</p>':''}${active(run.status)?'<p role="status" class="muted">Working on it. This page updates while it’s open.</p>':''}${run.status==='succeeded'&&!result?errorMarkup('This run finished without a readable report. That doesn’t mean there were no findings.'):''}${run.status==='succeeded'&&result?`<p class="notice">The model’s review of the code · No tests were run</p><p class="goal">${esc(result.summary)}</p><h3>Findings (${result.findings.length})</h3>${result.findings.length?result.findings.map((f,i)=>`<article class="finding"><span class="badge">${esc(f.severity)}</span><h3>${esc(f.title)}</h3><p class="mono">${esc(f.path)}:${f.line}</p><pre>${esc(f.evidence)}</pre>${checkpoint?findingReviewMarkup(checkpoint.findings[i],i):''}${checkpoint&&S.apiVersion>=14?`<button type="button" data-record-exception="${i}"${S.busy||!usable()?' disabled':''}>Add exception…</button>`:''}${checkpoint&&!archived()&&!currentTree()&&handoffSourceAllowed(m)?`<button type="button" data-handoff-finding="${i}"${S.busy||!usable()?' disabled':''}>Hand off to another Pip…</button>`:''}<div class="actions"><button type="button" data-finding="${i}"${S.busy||!usable()||!S.context?' disabled':''}>Save to context…</button></div></article>`).join(''):'<p class="muted">No findings this time. That doesn’t mean the code has no problems.</p>'}<div class="section"><h3>What it checked, and limits</h3><p>${esc(result.verification)}</p>${result.limitations.map(x=>`<p class="muted">${esc(x)}</p>`).join('')}</div>`:''}</section>`;
}
// What a Pulse runs (API 60): tests or checks on a copy of the code, or read-only commands on live data.
function pulseModeMarkup(){
 if(S.apiVersion<60)return '';
 const option=(value,label)=>`<label class="check-field"><input type="radio" name="pulseMode" data-draft="pulseMode" value="${value}"${draft.pulseMode===value?' checked':''}> ${label}</label>`;
 return `<fieldset class="pulse-mode"><legend>What it runs</legend>${option('tests','Tests or page checks on a copy of the code')}${option('live','Read-only commands on live data, with a short summary')}</fieldset>`;
}
function liveCommandsEditor(){
 return `<p class="notice">DGC runs only these exact commands, read-only, and its model sums up what they print. A command that writes is refused.</p><label for="liveCommands">Commands, one a line (up to 6)</label><textarea id="liveCommands" class="live-commands" data-draft="liveCommands" rows="5" spellcheck="false" autocomplete="off" placeholder="sqlite3 -readonly data/app.db &quot;SELECT count(*) FROM orders&quot;&#10;df -h .&#10;curl -s http://127.0.0.1:8000/health">${esc(draft.liveCommands)}</textarea>${liveReachMarkup()}`;
}
function liveReachMarkup(){
 return `<details class="live-reach"><summary>What these commands can reach</summary><p class="muted">They run in your project folder as it is now, in a read-only box: nothing they run can change a file. They reach only the local addresses they name (localhost or 127.0.0.1 with a port) and this project’s read-only database. Each gets up to a minute and 64 KB of output.</p><p class="muted">For a database, use a read-only account: <code>dgc readonly-db guide</code> shows how to make one and <code>dgc readonly-db set</code> keeps it for this project. A command reaches it as <code>$DGC_READONLY_DATABASE_URL</code>. For SQLite, open the file with <code>sqlite3 -readonly</code>.</p></details>`;
}
function liveCommandsReview(value,label='Commands it runs'){
 try{const plan=livePlan(value);if(!plan)return '<p class="muted">No live-data commands.</p>';return `<p class="notice">${esc(label)}: these exact read-only commands · its model sums up what they print</p><ol class="live-command-list">${plan.commands.map(line=>`<li><pre>${esc(line)}</pre></li>`).join('')}</ol>${liveReachMarkup()}`;}catch(error){return errorMarkup(errorText(error));}
}
function pulsePlanEditor(){
 if(S.apiVersion>=60&&draft.pulseMode==='live')return pulseModeMarkup()+liveCommandsEditor();
 return pulseModeMarkup()+pulsePlanEditorBody();
}
function pulsePlanEditorBody(){
 if(S.pip?.verification_plan?.action?.network==='loopback_http_v1')return `<label class="check-field"><input type="checkbox" id="verificationEnabled" data-draft="verificationEnabled"${draft.verificationEnabled?' checked':''}> Keep these local page checks</label>${draft.verificationEnabled?pulsePlanReview(S.pip.verification_plan):'<p class="muted">Unticked, this removes the checks. To remove the schedule too, choose Manual only. Then review the change.</p>'}<p class="muted">To change the addresses, use Change in chat. Changing the schedule keeps these checks.</p>`;
 return `<p class="notice">A command plan lets Pulse run these exact commands when you ask or on a schedule, without the model. Chat and handoffs work as before.</p><label class="check-field"><input type="checkbox" id="verificationEnabled" data-draft="verificationEnabled"${draft.verificationEnabled?' checked':''}> Use a command plan</label>${draft.verificationEnabled?`<p class="muted">Each box is one argument, spaces included. Nothing is split or run through a shell. Up to 4 commands, each with up to 32 arguments.</p>${pulseCommands.map((t,i)=>`<fieldset><legend>Command ${i+1}</legend>${t.argv.map((arg,j)=>`<label for="pulse-${i}-arg-${j}">${j===0?'Executable':`Argument ${j}`}<input id="pulse-${i}-arg-${j}" data-pulse-command="${i}" data-pulse-arg="${j}" value="${esc(arg)}" autocomplete="off" spellcheck="false"></label>${j>0?`<button type="button" data-pulse-remove-arg="${i}:${j}">Remove argument ${j}</button>`:''}`).join('')}<button type="button" data-pulse-add-arg="${i}"${t.argv.length>=32?' disabled':''}>Add argument</button><label for="pulse-${i}-cwd">Folder to run in (relative to the project)<input id="pulse-${i}-cwd" data-pulse-command="${i}" value="${esc(t.cwd)}" autocomplete="off" spellcheck="false"></label>${pulseCommands.length>1?`<button type="button" data-pulse-remove-command="${i}">Remove command ${i+1}</button>`:''}</fieldset>`).join('')}${button('pulse-add-command','Add command',pulseCommands.length>=4)}<p class="muted">Commands run on a read-only copy of the committed code, with no network; they can write only to a private scratch folder. ${seatbeltRunner()?'Each command gets up to 60 seconds, 30 seconds of CPU per process and 64 KB of output. On macOS, the 512 MB memory, 32-process and 64 MB scratch limits are checked every so often, not enforced exactly.':'Each command gets up to 60 seconds, 30 seconds of CPU and 512 MB of memory per process, 64 KB of output and 32 processes. Total memory is checked every so often, so it isn’t an exact cap.'}</p>`:'<p class="muted">No command plan. Removing a plan also removes its schedule. Past results stay; to run commands later, use a handoff.</p>'}`;
}
function pulsePlanReview(value){
 try{const plan=pulsePlan(value);if(!plan)return '<p class="muted">No command plan.</p>';if(plan.action.network==='loopback_http_v1')return `<p class="notice">Allowed: local page checks only · no model</p>${plan.action.tests.map(t=>`<article class="entry"><h4>GET ${esc(t.argv[1])}</h4><p>Expects status ${esc(t.argv[2])}</p></article>`).join('')}<p class="muted">Each check waits up to 10 seconds and reads up to 64 KB. No redirects, sign-ins, cookies or other sites. It checks the app that’s running now, which may not match the committed code, and only the status code: not how pages look, or anything behind a sign-in.</p>`;return `<p class="notice">Allowed: these exact commands only · no model · no network</p>${plan.action.tests.map((t,i)=>`<article class="entry"><h4>Command ${i+1}</h4><ol start="0">${t.argv.map(arg=>`<li><pre>${esc(arg)}</pre></li>`).join('')}</ol><p class="mono">Runs in: ${esc(t.cwd)}</p></article>`).join('')}<p class="muted">Runs on a read-only copy of the code with a private scratch folder. Each command: ${seatbeltRunner()?'up to 60 seconds, 30 seconds of CPU per process and 64 KB of output (on macOS, memory and process limits are checked every so often)':'up to 60 seconds, 30 seconds of CPU and 512 MB of memory per process, 64 KB of output and 32 processes'}. No network, no changes to the code, no model and no automatic retries. On a schedule, it runs at each scheduled time until you change or remove it.</p>`;}catch(error){return errorMarkup(errorText(error));}
}
function pulseProposalBody(proposal,{stale,unavailable,pulseUnsupported,reject}){
 const next=proposal.definition;
 const live=next.live_plan!=null||S.pip.live_plan!=null;
 const commandsNow=live&&S.pip.live_plan!=null?liveCommandsReview(S.pip.live_plan,'Now'):pulsePlanReview(S.pip.verification_plan);
 const commandsAfter=next.live_plan!=null?liveCommandsReview(next.live_plan,'After'):pulsePlanReview(next.verification_plan);
 return `<h3>${esc(next.name)}</h3><p class="muted">Asked ${proposal.actor?esc(requester(proposal.actor)):'by someone not recorded'} · ${proposal.expires_at?'Expires '+esc(date(proposal.expires_at)):'No expiry recorded'}</p><p class="goal">${esc(proposal.reason)}</p><h3>Commands it may run</h3>${commandsAfter}${S.pip.live_plan!=null&&next.live_plan==null?'<p class="notice">This removes its live-data commands. Past results stay. Nothing runs now.</p>':''}${S.pip.verification_plan!=null&&next.verification_plan==null?'<p class="notice">This removes the command plan and its schedule. Past results stay. Nothing runs now.</p>':''}<h3>Schedule</h3><dl class="meta"><dt>Now</dt><dd>${esc(scheduleLabel(S.pip.schedule))}</dd><dt>After</dt><dd>${esc(scheduleLabel(next.schedule))}</dd><dt>Branch or commit</dt><dd>${esc(S.pip.source_ref)} → ${esc(next.source_ref)}</dd></dl><p class="muted">Each run uses the latest commit on that branch when it starts. Pulse can’t run on events or on uncommitted files. A paused or busy Pip skips a scheduled time; if Pips were off, it runs once for the times it missed. A one-time run counts even if it fails or is cancelled. Nothing retries on its own.</p><details><summary>Commands now</summary>${commandsNow}</details><details><summary>Everything else</summary><dl class="meta"><dt>Name</dt><dd>${esc(S.pip.name)} → ${esc(next.name)}</dd><dt>What it does now</dt><dd>${esc(S.pip.goal)}</dd><dt>What it would do</dt><dd>${esc(next.goal)}</dd><dt>Source</dt><dd>${esc(sourcePolicyLabel(next.source_policy))}</dd><dt>Changes it may make to itself</dt><dd>${esc(adaptationLabel(next.adaptation_policy))}</dd><dt>Model</dt><dd>${esc(modelLabel(next.model_choice))} · ${next.live_plan!=null?'writes the summary of what they print':'not used for commands'}</dd></dl></details><details><summary>Full setup (JSON)</summary><pre>${esc(JSON.stringify(next,null,2))}</pre></details>${pulseUnsupported?errorMarkup('Update DGC and refresh before accepting this change.'):''}${!reject&&stale?errorMarkup('This Pip changed after this was written. Turn it down and ask again.'):''}${unavailable?errorMarkup('This was already answered or is no longer available. Refresh to see it.'):''}${proposal.expires_at&&Date.parse(proposal.expires_at)<=Date.now()?errorMarkup('This expired. Ask again for a new one.'):''}`;
}
// A live-data Pip's History (API 60): Run now, and each run's summary in a few words.
function liveRunsMarkup(runs){
 const disabled=S.busy||!usable()||S.apiVersion<60||!S.runner?.online||S.runner.paused||S.pip.status!=='active'||!!S.pip.active_run||runs.some(r=>active(r.status));
 return `<section class="section"><div class="section-head"><h2>${historyName('Live data runs')}</h2>${button('run','Run now',disabled,'primary')}</div><p class="muted">Each run runs its approved read-only commands, and its model sums up what they print${postsShown()?'. The summary is also in its chat, where you can ask about it':''}. Nothing it runs changes anything.</p>${S.apiVersion<60?'<p class="notice">Update DGC to run a live-data Pip.</p>':''}${!S.runner?.online?'<p class="muted">Pips aren’t running. Start Pips to run it.</p>':''}<div class="actions"><button type="button" data-tab="schedule">Commands and schedule</button></div>${runs.map(r=>`<div class="run-row"><button type="button" data-run="${esc(r.id)}" aria-current="${S.runId===r.id}"><span>${rowWords(r,esc(statusLabel(r.status)))}</span><small>${esc(date(r.created_at))}</small></button></div>`).join('')||'<p class="muted">No runs yet.</p>'}</section>${reportMarkup()}`;
}
const LIVE_STATUS={ok:'Ran',failed:'Failed',timed_out:'Ran out of time',output_limit:'Printed too much',refused:'Refused',cancelled:'Stopped',not_run:'Didn’t run'};
function liveReportMarkup(run){
 const live=record(run.result)&&record(run.result.live)?run.result.live:null,m=record(run.manifest)?run.manifest:{};
 const commands=Array.isArray(live?.commands)?live.commands.filter(record):[],ok=commands.filter(c=>c.status==='ok').length;
 const title=run.status==='succeeded'&&live?(live.attention?'Needs you':'All clear'):personalStatusLabel(run.status);
 const by=live?(live.summary_by==='model'?'Its model’s summary. Every number in it is in the output below.':`DGC’s words${Array.isArray(live.notes)&&live.notes[0]?': '+esc(live.notes[0]):'.'}`):'';
 return `<section class="section" aria-label="Live data run"><div class="section-head"><h2>${esc(title)}</h2>${active(run.status)?button('cancel-run','Cancel run…',S.busy||!usable(),'danger'):''}</div>${live?`<p class="goal live-summary">${esc(live.summary)}</p><p class="muted">${by}</p>`:''}${run.status==='failed'?errorMarkup(errorText(run.error)):''}${run.status==='cancelled'?'<p class="notice">Cancelled before it finished.</p>':''}${active(run.status)?'<p role="status" class="muted">Running its approved commands. This page updates while it’s open.</p>':''}<dl class="meta"><dt>Started by</dt><dd>${m.trigger==='schedule'?'Its schedule':m.trigger==='main_chat'?'A chat':'You'}</dd>${m.trigger==='schedule'?`<dt>Scheduled for</dt><dd>${esc(date(m.scheduled_at))}</dd>`:''}<dt>Commands</dt><dd>${commands.length?`${ok} of ${commands.length} ran`:'None recorded'}</dd><dt>Model</dt><dd>${esc(m.model||'Not recorded')} · writes the summary only</dd></dl>${commands.map(c=>`<article class="entry live-command"><h3>${esc(LIVE_STATUS[c.status]||String(c.status))}${Number.isSafeInteger(c.exit_code)&&c.status!=='ok'?` · exit code ${c.exit_code}`:''}</h3><pre class="live-command-line">$ ${esc(c.command)}</pre><pre>${esc(c.output||'No output.')}</pre>${c.output_truncated?'<p class="notice">Only the start of its output is kept.</p>':''}${c.note?`<p class="muted">${esc(c.note)}</p>`:''}</article>`).join('')}${live?'<p class="muted">Read-only commands from its approved list, run in a read-only box. The output is from a live system at the time it ran. Nothing was changed.</p>':''}${activityMarkup()}</section>`;
}
function pulseRunsMarkup(runs){
 let eligible=false,invalid='';try{eligible=!!pulsePlan(S.pip.verification_plan);if(eligible)pulseRunPins(S.pip);}catch(error){eligible=false;invalid=errorText(error);}
 const disabled=S.busy||!usable()||S.apiVersion<21||!eligible||!S.runner?.online||S.runner.paused||S.pip.status!=='active'||!!S.pip.active_run||runs.some(r=>active(r.status))||!supportedSource();
 return `<section class="section"><div class="section-head"><h2>${historyName('Command runs')}</h2>${eligible?button('run','Run approved commands',disabled,'primary'):''}</div><p class="muted">${eligible?'Runs your approved commands exactly, without the model. Each command gets its own result.':'Add a command plan in Plan & schedule to run commands when you ask or on a schedule. Handoffs still work.'} Chatting with it never runs commands.</p>${errorMarkup(invalid)}${S.apiVersion<21?'<p class="notice">Update DGC to use a command plan.</p>':''}<div class="actions"><button type="button" data-tab="schedule">Plan & schedule</button><button type="button" data-tab="handoffs">Open handoffs</button></div>${runs.map(r=>`<div class="run-row"><button type="button" data-run="${esc(r.id)}" aria-current="${S.runId===r.id}"><span>${rowWords(r,r.execution_mode==='standalone_plan'&&pulseProgress(r)?`${pulseProgress(r).failed} failed · ${pulseProgress(r).passed} passed · ${esc(personalStatusLabel(r.status))}`:r.manifest?.pulse_verification&&r.status==='succeeded'?'Commands finished':esc(statusLabel(r.status)))}</span><small>${esc(date(r.created_at))}</small></button></div>`).join('')||'<p class="muted">No command runs yet.</p>'}</section>${reportMarkup()}`;
}
function pulseReportMarkup(run){
 let grant=null,receipt=null,error='';try{grant=pulseVerificationPin(run.manifest);if(!grant||grant.pip_id!==run.pip_id||grant.pip_id!==S.selected||grant.workspace_id!==S.workspace.id||run.workspace_id!==undefined&&run.workspace_id!==grant.workspace_id)throw Error('This run’s approval doesn’t match this Pip. Refresh to try again.');if(run.result!=null)receipt=pulseVerificationReceipt(run.result,run.manifest,run.status);else if(!active(run.status))throw Error('This run’s results are missing.');}catch(e){grant=null;receipt=null;error=errorText(e);}
 const counts={passed:0,failed:0,stopped:0,unexecuted:0,unknown:0};for(const c of receipt?.commands||[]){const label=pulseCommandLabel(c);counts[label==='Passed'?'passed':label==='Failed'?'failed':label==='Stopped'?'stopped':label==='Didn’t run'?'unexecuted':'unknown']++;}
 const title=receipt?`${counts.failed} failed · ${counts.passed} passed`:'Results unavailable';
 return `<section class="section" aria-label="Pulse command receipt"><div class="section-head"><h2>${esc(title)}</h2>${active(run.status)?button('cancel-run','Cancel run…',S.busy||!usable(),'danger'):''}</div>${grant?'<p class="notice">Results of the exact commands · no model. Exit code 0 means a command succeeded; it doesn’t prove the tests cover everything or that the code is correct.</p>':'<p class="notice">Results aren’t available. Don’t count this as a passed check.</p>'}${grant&&run.manifest.job.verification_plan.action.network==='loopback_http_v1'?'<p class="notice">Local page status checks only. The running app may not match the committed code, and these don’t check how pages look or anything behind a sign-in.</p>':''}${errorMarkup(error)}${run.error?errorMarkup(errorText(run.error)):''}${receipt?`<p>${counts.stopped} stopped · ${counts.unexecuted} didn’t run · ${counts.unknown} unknown</p><p class="muted">${receipt.phase==='running'?'Still running. These numbers may change.':`${outcomeWords(receipt.terminal_reason)}.`} A command that started but never reported back has an unknown result; commands after a stop don’t run.</p>`:''}${grant?`<dl class="meta"><dt>Status</dt><dd>${esc(personalStatusLabel(run.status))}</dd><dt>Model</dt><dd>Not used</dd><dt>Version</dt><dd>${grant.job_version}</dd><dt>Started by</dt><dd>${grant.trigger==='schedule'?'Its schedule':'You'}</dd>${grant.trigger==='schedule'?`<dt>Scheduled for</dt><dd>${esc(date(run.manifest.scheduled_at))}</dd>`:''}${pinnedSourceMarkup(run.manifest)}</dl>${receipt?receipt.commands.map((c,i)=>{const approved=run.manifest.job.verification_plan.action.tests[i],t=c.outcome;return `<article class="entry"><h3>Command ${i+1} · ${esc(pulseCommandLabel(c))}</h3><ol start="0">${approved.argv.map(arg=>`<li><pre>${esc(arg)}</pre></li>`).join('')}</ol><p class="mono">Runs in: ${esc(approved.cwd)}</p>${t?`<p>Exit code: ${t.exit_code===null?'didn’t start':t.exit_code} · ${esc(outcomeWords(t.status))}</p><pre>${esc(t.output||'No output recorded.')}</pre>${t.output_truncated?'<p class="notice">Only the start of the output is shown.</p>':''}<details><summary>Saved output</summary><p class="mono">${esc(t.artifact.path)} · ${t.artifact.bytes} bytes</p><p class="mono">SHA-256 ${esc(t.artifact.sha256)}</p><p class="muted">The full output is kept privately by DGC. The preview above may hide secrets.</p></details>`:''}</article>`;}).join(''):'<p role="status">No results saved yet.</p>'}<details><summary>Technical details</summary><dl class="meta"><dt>Run ID</dt><dd class="mono">${esc(run.id)}</dd><dt>Approval ID</dt><dd class="mono">${esc(grant.approval_id)}</dd><dt>Plan fingerprint</dt><dd class="mono">${esc(grant.plan_digest)}</dd><dt>Approval fingerprint</dt><dd class="mono">${esc(grant.digest)}</dd><dt>Setup fingerprint</dt><dd class="mono">${esc(grant.definition_digest)}</dd></dl><p class="muted">These identify what was approved. Command-plan results can’t be reviewed or saved to context.</p></details>`:''}${activityMarkup()}</section>`;
}
// Where its reports go besides here (dgc/pip_report_delivery.py): a card in the chats it reports to,
// or, with none, how to have one. get_pip's report_chats; an older CLI sends none and this says nothing.
function reportChatsNote(){
  const n=S.pip?.report_chats;
  if(!Number.isSafeInteger(n)||n<0)return '';
  return `<p class="muted report-chats">${n?`Its finished reports also appear as a card in ${n===1?'the chat it reports to':`the ${n} chats it reports to`}: the chat it was set up in, and any chat it is attached to. Nothing changes until you ask there.`:`${postsShown()?'Its reports post in its own chat and stay here.':'Its reports stay here.'} To have them appear in a chat as a card you can act on, ask DGC in that chat: “attach ${esc(S.pip.name)} to this chat”.`}</p>`;
}
// Runs became History (API 51): every run, newest first, each row saying what it found; the chat has the posts.
function historyName(old){return postsShown()?'History':old;}
function rowWords(r,fallback){
  const post=postsShown()&&S.postsPip===S.selected?postFor(r.id):null;if(!post)return fallback;
  const w=postShort(post);return `<span class="hist-row-out" data-tone="${esc(w.tone)}">${esc(w.text)}</span>`;
}
function runsMarkup() {
  const audits=S.runs.filter(r=>r.manifest?.run_kind!=='conversation');
  if(S.pip?.source_policy?.mode==='personal')return `<section class="section"><div class="section-head"><h2>${historyName('Results')}</h2></div><p class="muted">${postsShown()?`Everything ${esc(S.pip.name)} did on its own, newest first. Each result is also in its chat, where you can ask about it. `:''}${S.pip.schedule||S.pip.event_trigger?`What ${esc(S.pip.name)} made on its schedule.`:`When ${esc(S.pip.name)} works on its own, on a schedule like “every morning, send me the news”, what it makes shows here. Ask for one in its chat.`}</p>${audits.map(r=>`<div class="run-row"><button type="button" data-run="${esc(r.id)}"><span>${rowWords(r,esc(personalStatusLabel(r.status)))}</span><small>${esc(date(r.created_at))}</small></button></div>`).join('')||'<p class="muted">No results yet.</p>'}</section>${reportMarkup()}`;
  if(livePip(S.pip))return reportChatsNote()+liveRunsMarkup(audits);
  if(pulsePip(S.pip))return reportChatsNote()+pulseRunsMarkup(audits);
  if(executionPip(S.pip))return `<section class="section"><h2>Runs</h2><p class="muted">It runs only when you approve a handoff to it, never on a schedule. Chatting with it never changes files.</p><button type="button" data-tab="handoffs">Open handoffs</button>${audits.map(r=>`<div class="run-row"><button type="button" data-run="${esc(r.id)}" aria-current="${S.runId===r.id}"><span>${esc(personalStatusLabel(r.status))}</span><small>${esc(date(r.created_at))}</small></button></div>`).join('')||'<p class="muted">No runs yet.</p>'}</section>${reportMarkup()}`;
  if(documentationPip(S.pip))return `<section class="section"><div class="section-head"><h2>${historyName('Documentation drafts')}</h2>${button('run','Create draft',S.busy||!usable()||!S.runner?.online||S.runner?.paused||S.pip?.status!=='active'||S.runs.some(r=>active(r.status))||!!S.pip?.active_run||!pipType(S.pip,S.types)?.available||!supportedSource(),'primary')}</div><p class="muted">Drafts it writes from the code, kept private. It never changes your files or publishes anything. ${postsShown()?'Each one is also in its chat, where you can ask about it.':'Chat replies stay in Chat.'}</p>${audits.map(r=>`<div class="run-row"><button type="button" data-run="${esc(r.id)}" aria-current="${S.runId===r.id}"><span>${rowWords(r,r.status==='succeeded'?'Draft ready':r.status==='running'?'Drafting documentation':esc(statusLabel(r.status)))}</span><small>${esc(date(r.created_at))}</small></button></div>`).join('')||'<p class="muted">No drafts yet.</p>'}</section>${reportMarkup()}`;
  return `<section class="section"><div class="section-head"><h2>${historyName('Audits')}</h2>${button('run','Run audit',S.busy||!usable()||!S.runner?.online||S.runner?.paused||S.pip?.status!=='active'||S.runs.some(r=>active(r.status))||!!S.pip?.active_run||!pipType(S.pip,S.types)?.available||!supportedSource(),'primary')}</div><p class="muted">${postsShown()?'Every audit, newest first: ones you start, scheduled ones and ones started by events. Each one also posts what it found in Chat, where you can ask about it.':'Reports from audits you start, scheduled ones and ones started by events. Chat replies stay in Chat.'}</p>${reportChatsNote()}${!S.runner?.online?'<p class="muted">Pips aren’t running. Start Pips to run an audit.</p>':''}${audits.length?audits.map(r=>`<div class="run-row"><button type="button" data-run="${esc(r.id)}" aria-current="${S.runId===r.id}"><span>${rowWords(r,statusLabel(r.status))}</span><small>${esc(date(r.created_at))}</small></button></div>`).join(''):'<p class="muted">No audits yet.</p>'}</section>${reportMarkup()}${checkpointHistoryMarkup()}`;
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
  draft.pulseMode=livePip(pip)?'live':'tests';draft.liveCommands=(pip.live_plan?.commands||[]).join('\n');
  pulseCommands=pip.verification_plan?.action?.tests?.map(t=>({argv:[...t.argv],cwd:t.cwd}))||[{argv:[''],cwd:'.'}];
  draft.scheduleType=value?.type||'manual';draft.scheduleMinutes=String(value?.minutes||60);
  const trigger=eventTrigger(pip.event_trigger);if(trigger)draft.scheduleType='events';draft.triggerContext=trigger?.events.includes('context_updated')??false;draft.triggerFinding=trigger?.events.includes('finding_accepted')??false;draft.triggerCommit=trigger?.events.includes('commit_changed')??false;draft.triggerSession=trigger?.events.includes('session_turn_completed')??false;draft.triggerMinutes=String(trigger?.minimum_minutes??5);draft.triggerPaths=trigger?.events.includes('committed_paths_changed')??false;commitRules=trigger?.commit_paths?.map(r=>({...r}))||[{kind:'exact',path:''}];
  draft.scheduleTime=value?.time||'09:00';draft.scheduleZone=value?.timezone||defaultZone;draft.scheduleAt=value?.at||'';draft.scheduleCron=value?.cron||'0 9 * * 1-5';
  S.scheduleDraftVersion=pip.current_version;
}
const sessionTurnNotice='Runs after a turn in a DGC chat on this computer is saved. The chat itself isn’t shared. It doesn’t mean the work is finished or that tests passed. The audit reads the committed code on its branch when it starts, not what the chat saw.';
const quillAutomationNotice='Quill writes private drafts with the model. It doesn’t publish anything, change shared context, or check its prose or tests. Each draft reads the latest local commit on its branch when it starts, which may be newer than the event that started it. No chat is shared.';
const commitPathNotice='Watches these paths in new local commits on its branch. Uncommitted edits and anything on a remote don’t count. The first check only notes where things are. Each run reads the latest commit when it starts, which may be newer than the one that woke it.';
function commitRulesMarkup(value,title='Paths it watches'){
 if(value==null)return '';try{const rules=commitPathRules(value);return `<h3>${esc(title)}</h3><ol>${rules.map(r=>`<li><span>${r.kind==='directory'?'Folder':'Exact path'}</span> <code>${esc(r.path)}</code></li>`).join('')}</ol>`;}catch(error){return errorMarkup(errorText(error));}
}
function commitRulesEditor(){
 return `<fieldset><legend>Paths to watch</legend>${commitRules.map((r,i)=>`<label for="commit-kind-${i}">Path ${i+1}<select id="commit-kind-${i}" data-commit-rule="${i}" data-commit-kind><option value="exact"${r.kind==='exact'?' selected':''}>Exact path</option><option value="directory"${r.kind==='directory'?' selected':''}>Folder (and everything in it)</option></select></label><label for="commit-path-${i}">Repository path<input id="commit-path-${i}" data-commit-rule="${i}" value="${esc(r.path)}" autocomplete="off" spellcheck="false"></label>${commitRules.length>1?`<button type="button" data-remove-commit-rule="${i}">Remove path ${i+1}</button>`:''}`).join('')}${button('add-commit-rule','Add path',commitRules.length>=32)}</fieldset><p class="muted">Exact paths, case-sensitive, no wildcards. Folder src matches src/a.py but not src2/a.py. Deleting a file counts as a change; symbolic links and submodules aren’t followed. Up to 32 paths.</p><p class="notice">Any other event you ticked can also start it, even without a path change. The minimum gap applies to all of them.</p><p class="muted">${esc(commitPathNotice)}</p>`;
}
function commitMatchMarkup(pin,manifest){
 const m=pin.commit_path_match;if(!m)return '';const c=m.comparison;return `<h4>Watched paths that changed</h4><ol>${c.matched_rule_indices.map(i=>{const r=pin.policy.commit_paths[i];return `<li>${r.kind==='directory'?'Folder':'Exact path'} <code>${esc(r.path)}</code></li>`;}).join('')}</ol><p>${c.changed_entries} changed ${c.changed_entries===1?'path':'paths'} in all.</p><dl class="meta"><dt>Before</dt><dd class="mono">${esc(c.before_revision)}</dd><dt>After</dt><dd class="mono">${esc(c.after_revision)}</dd><dt>Commit this run read</dt><dd class="mono">${esc(manifest.source_revision)}</dd></dl><p class="notice">These commits are what woke it; the run read the latest commit when it started. Changes in between may not have been seen. This isn’t a test result.</p><details><summary>Technical details</summary><dl class="meta"><dt>Branch or commit</dt><dd>${esc(m.source_ref)}</dd><dt>Paths fingerprint</dt><dd class="mono">${esc(m.policy_digest)}</dd><dt>Comparison fingerprint</dt><dd class="mono">${esc(c.digest)}</dd><dt>Match fingerprint</dt><dd class="mono">${esc(m.digest)}</dd><dt>Workspace link</dt><dd class="mono">${esc(m.binding_id)}</dd></dl></details>`;
}

function pathProposalBody(proposal,{stale,unavailable,pathUnsupported,reject}){
 const next=proposal.definition;return `<h3>${esc(next.name)}</h3><p class="goal">${esc(proposal.reason)}</p><dl class="meta"><dt>Starts on now</dt><dd>${esc(eventTriggerLabel(S.pip.event_trigger))}</dd><dt>Would start on</dt><dd>${esc(eventTriggerLabel(next.event_trigger))}</dd><dt>Branch or commit</dt><dd>${esc(S.pip.source_ref)} → ${esc(next.source_ref)}</dd><dt>Schedule after</dt><dd>${esc(scheduleLabel(next.schedule))}</dd><dt>Asked</dt><dd>${proposal.actor?esc(requester(proposal.actor)):'Not recorded'}</dd><dt>Expires</dt><dd>${proposal.expires_at?esc(date(proposal.expires_at)):'Not recorded'}</dd></dl>${commitRulesMarkup(S.pip.event_trigger?.commit_paths,'Paths it watches now')}${commitRulesMarkup(next.event_trigger?.commit_paths,'Paths it would watch')}${!next.event_trigger?.commit_paths?'<p class="notice">This stops watching specific paths. Check the other events above.</p>':''}<p class="notice">Any other event you ticked can also start it, even without a path change. The minimum gap applies to all of them.</p><p class="muted">${esc(commitPathNotice)}</p><p class="muted">Accepting doesn’t replay past events. A paused or busy Pip skips what it missed; an active one runs once for several events. It gets no new permissions.</p>${documentationPip(S.pip)?`<p class="notice">${esc(quillAutomationNotice)}</p>`:''}${next.event_trigger?.events?.includes('session_turn_completed')?`<p class="muted">${esc(sessionTurnNotice)}</p>`:''}<details><summary>Full setup (JSON)</summary><pre>${esc(JSON.stringify(next,null,2))}</pre></details>${pathUnsupported?errorMarkup('These paths can’t be accepted here. Update DGC, then refresh.'):''}${!reject&&stale?errorMarkup('This Pip changed after this was written. Turn it down and ask again.'):''}${unavailable?errorMarkup('This was already answered or is no longer available. Refresh to see it.'):''}`;
}
function commitObservationMarkup(pip){
 if(!pip.event_trigger?.commit_paths)return '';try{const value=commitPathObservation(pip.commit_path_observation,pip);if(!value)return '<p class="muted">It hasn’t checked these paths yet.</p>';if(value.status==='unavailable')return '<p class="notice">The last check couldn’t be read. That doesn’t mean nothing changed.</p>';
 const p=value.last_probe,c=value.last_comparison,labels={baselined:'First check, nothing to compare yet',unchanged:'No new commit',compared:'Compared',unavailable:'Last check failed'};return `<details data-details="commit-observation"><summary>Path checks · ${p?esc(labels[p.status]):'not checked yet'}</summary><p class="muted">From the last check; opening this doesn’t check again.</p><dl class="meta"><dt>Starting commit</dt><dd class="mono">${esc(value.revision??'None yet')}</dd><dt>Last checked</dt><dd>${value.last_checked_at?esc(date(value.last_checked_at)):'Not checked yet'}</dd>${p?.reason?`<dt>Why the check failed</dt><dd>${esc(p.reason.replaceAll('_',' '))}</dd>`:''}<dt>New commits seen</dt><dd>${value.observed_changes}</dd></dl>${c?`<h4>Last comparison</h4><p>${esc(date(value.last_comparison_at))} · ${c.status==='matched'?'Watched paths changed':'No watched path changed'} · ${c.changed_entries} changed ${c.changed_entries===1?'path':'paths'}</p><dl class="meta"><dt>Before</dt><dd class="mono">${esc(c.before_revision)}</dd><dt>After</dt><dd class="mono">${esc(c.after_revision)}</dd></dl>${c.matched_rule_indices.length?commitRulesMarkup(c.matched_rule_indices.map(i=>pip.event_trigger.commit_paths[i]),'Paths that changed'):''}<p class="muted">If a later check fails, this keeps its original time. A change here doesn’t always mean a run started.</p>`:'<p class="muted">Not compared yet, so changes are unknown.</p>'}</details>`;
 }catch(error){return errorMarkup(errorText(error));}
}

function eventTriggerFields(){return `<fieldset><legend>Run after these changes</legend>${[['triggerContext',EVENT_TRIGGER_NAMES.context_updated],['triggerFinding',EVENT_TRIGGER_NAMES.finding_accepted],['triggerCommit',EVENT_TRIGGER_NAMES.commit_changed],...(S.apiVersion>=18?[['triggerSession',EVENT_TRIGGER_NAMES.session_turn_completed]]:[]),...(S.apiVersion>=22?[['triggerPaths',EVENT_TRIGGER_NAMES.committed_paths_changed]]:[])].map(([id,label])=>`<label class="check-field"><input type="checkbox" id="${id}" data-draft="${id}"${draft[id]?' checked':''}${id==='triggerCommit'&&draft.triggerPaths||id==='triggerPaths'&&draft.triggerCommit?' disabled':''}> ${label}</label>`).join('')}</fieldset>${draft.triggerPaths?S.apiVersion>=22?commitRulesEditor():'<p class="notice">Update DGC to change the paths it watches.</p>':''}<label>At least this many minutes apart<input id="triggerMinutes" data-draft="triggerMinutes" type="number" min="5" max="10080" step="1" value="${esc(draft.triggerMinutes)}" required></label><p class="muted">Context changes when a record is added or archived. A finding counts only when you accept it, not when a Pip reports it. Commits are watched on this Pip’s branch on this computer; uncommitted edits don’t count, and nothing is fetched from a remote. The first check only notes the current commit.</p>${S.apiVersion>=18?`<p class="muted">${esc(sessionTurnNotice)}</p>`:''}<p class="muted">This is the shortest gap between runs, not a set time. Only events after you accept count. If several happen while Pips are off, an active Pip runs once; a paused or busy one skips them. Runs never overlap.</p>`;}
function currentEventMarkup(p){const state=record(p.event_trigger_state)?p.event_trigger_state:null;return p.event_trigger?`<section class="section" aria-label="Runs on events"><h2>Runs on events</h2><p>${esc(eventTriggerLabel(p.event_trigger))}</p>${commitRulesMarkup(p.event_trigger.commit_paths)}${commitObservationMarkup(p)}<dl class="meta"><dt>Earliest next run</dt><dd>${state?.next_allowed_at?esc(date(state.next_allowed_at)):'Not recorded'}</dd><dt>Last checked</dt><dd>${state?.last_checked_at?esc(date(state.last_checked_at)):'Not checked yet'}</dd></dl><p class="muted">Times are in ${esc(defaultZone)}. It runs then only if a new event has happened and Pips are running.</p></section>`:'';}
function scheduleMarkup() {
  if(archived())return `<section class="section"><h2>Archived schedule</h2><p>${esc(S.pip.event_trigger?eventTriggerLabel(S.pip.event_trigger):scheduleLabel(S.pip.schedule))}</p><p class="muted">It doesn’t run while archived. Restore it in Settings, then resume it.</p></section>`;
  if(currentTree())return '<section class="section"><h2>Runs when you ask</h2><p class="muted">It reads your current files, so it can’t run on a schedule or on events. To schedule it, switch it to committed code in Settings, under Advanced.</p></section>';
  if(pulsePip(S.pip)&&S.apiVersion<21)return '<section class="section"><h2>Command plans</h2><p class="notice">Update DGC to give Pulse a command plan and schedule. Handoffs and chat still work.</p></section>'+savedProposalsMarkup();
  if(executionPip(S.pip)&&!pulsePip(S.pip))return '<section class="section"><h2>Handoffs only</h2><p class="muted">Patch doesn’t run on a schedule. Each time, you approve a handoff that says exactly which files it may change. Chatting with it never changes files.</p></section>';
  const p=S.pip,state=record(p.schedule_state)?p.schedule_state:null,quill=documentationPip(p),pulse=pulsePip(p),legacyQuill=quill&&S.apiVersion<20;
  const upgrade='<p class="notice">Update DGC to schedule Quill or run it on events. You can still ask it for drafts.</p>';
  if(legacyQuill&&!p.schedule&&!p.event_trigger)return `<section class="section"><h2>Drafts when you ask</h2>${upgrade}</section>${savedProposalsMarkup()}`;
  const choices=[['manual','Manual only'],...(!legacyQuill&&(!pulse||draft.verificationEnabled)?[['interval','Interval'],['daily','Daily'],['once','Once'],['cron','Cron'],...(S.apiVersion>=10&&!pulse&&!personalPip()?[['events','On events']]:[])]:draft.scheduleType!=='manual'?[[draft.scheduleType,'Current setting (update DGC to change it)']]:[])];
  return `${legacyQuill?upgrade:''}${quill?`<p class="notice">${esc(quillAutomationNotice)}</p>`:''}${currentEventMarkup(p)}<section class="section"><h2>Current schedule</h2><p>${esc(p.event_trigger?'Runs on events, not a schedule':scheduleLabel(p.schedule))}</p>${p.schedule?`<dl class="meta"><dt>Next run</dt><dd>${state?.next_due_at?esc(date(state.next_due_at)):'None scheduled'}</dd><dt>Last run time</dt><dd>${state?.last_due_at?esc(date(state.last_due_at)):'None yet'}</dd></dl><p class="muted">Times are in ${esc(defaultZone)}.</p>`:''}${p.status==='paused'||S.runner?.paused?'<p class="notice">Paused. Its schedule waits until you resume it (and Pips, if they’re stopped).</p>':''}<p class="muted">${personalPip()?'On schedule it does its task, with any app reads you approved.':pulse?(livePip(p)?'On schedule it runs its approved read-only commands, and its model sums up what they print.':'On schedule it runs only your approved commands, without the model.'):quill?'On schedule it writes a private draft from the code. It can only read.':'On schedule it audits the code the same way, read-only.'} Pips must be running. A paused or busy Pip skips a scheduled time and picks up at the next one. If Pips were off or stopped, an active Pip runs once for the times it missed, not once for each. Stop all also pauses every Pip; resume each one yourself.</p><p class="muted">When clocks change, a time that doesn’t exist that day is skipped, and a time that happens twice runs once. A one-time run missed while paused or busy doesn’t come back, even if you change its goal or model.</p></section><form id="schedule-form" class="section form"><h2>${pulse?'Command plan and schedule':'Change schedule'}</h2>${pulse?pulsePlanEditor():''}${pulse?'<p class="muted">You approve the commands once before they can run.</p>':''}<label for="scheduleType">Run schedule</label><select id="scheduleType" data-draft="scheduleType">${choices.map(([key,label])=>`<option value="${key}"${draft.scheduleType===key?' selected':''}>${label}</option>`).join('')}</select>${draft.scheduleType==='events'?eventTriggerFields():draft.scheduleType==='interval'?`<label>Interval in minutes<input id="scheduleMinutes" data-draft="scheduleMinutes" type="number" min="5" max="10080" step="1" value="${esc(draft.scheduleMinutes)}" required></label><p class="muted">From 5 minutes to 7 days.</p>`:draft.scheduleType==='daily'?`<div class="two-fields"><label>Time<input id="scheduleTime" data-draft="scheduleTime" type="time" step="60" value="${esc(draft.scheduleTime)}" required></label>${field('scheduleZone','Time zone')}</div><p class="muted">A time zone name, like Europe/Paris.</p>`:draft.scheduleType==='once'?`${field('scheduleAt','Date and time, with its offset')}<p class="muted">For example 2099-10-02T09:00:00+05:30 (include the offset). It must still be in the future when you accept the change.</p>`:draft.scheduleType==='cron'?`${field('scheduleCron','Cron schedule')}${field('scheduleZone','Time zone')}<p class="muted">Five fields, numbers only: minute hour day month weekday. Use *, lists, ranges and steps like */15; no names such as MON. Runs must be at least 5 minutes apart. If you set both day fields, either can match. DGC refuses a schedule that never runs or waits more than a year.</p>`:''}<button type="submit" class="primary"${S.busy||!usable()?' disabled':''}>${pulse?'Review plan and schedule…':draft.scheduleType==='events'?'Review trigger…':'Review schedule…'}</button>${S.scheduleDraftVersion!==p.current_version?'<p class="notice">This Pip changed while you edited this. Reset and choose again.</p>':''}<div class="actions">${button('reset-schedule','Reset',S.busy||!usable())}</div></form>${pulse?capabilityMarkup():''}${savedProposalsMarkup()}`;
}
function specialistDraft(){const roles=SPECIALIST_ROLES.filter(role=>draft['specialist'+role[0].toUpperCase()+role.slice(1)]);if(!roles.length)return undefined;if(S.apiVersion<15)throw Error('Update DGC to use helpers.');return specialistGrant({roles,max_calls:Number(draft.specialistCalls)});}
function specialistFormMarkup(){if(S.apiVersion<15)return '<p class="muted">Update DGC to let Patch call helpers.</p>';return `<details data-details="specialist-grant"><summary>Helpers (optional)</summary><p class="muted">Off unless you tick them. Choose which helpers this one Patch run may call.</p>${SPECIALIST_ROLES.map(role=>{const key='specialist'+role[0].toUpperCase()+role.slice(1);return `<label class="check-field"><input type="checkbox" id="${key}" data-draft="${key}"${draft[key]?' checked':''}> ${role[0].toUpperCase()+role.slice(1)} · ${role==='worker'?'may edit the same files':'read only'}</label>`;}).join('')}<label for="specialistCalls">Helper calls in all</label><select id="specialistCalls" data-draft="specialistCalls">${[1,2,3].map(n=>`<option value="${n}"${String(n)===draft.specialistCalls?' selected':''}>${n}</option>`).join('')}</select><p class="muted">Helpers use this run’s model and private copy, and work until it ends: no limit on model requests, tool calls or time. They can’t run in the background, call other helpers, use a shell or the network. Test commands are still approved separately.</p></details>`;}
function specialistGrantMarkup(grant){if(grant===undefined)return '';const g=specialistGrant(grant);return `<section class="section" aria-label="Helpers"><h3>Helpers</h3><p>${esc(g.roles.map(r=>r[0].toUpperCase()+r.slice(1)).join(', '))} · up to ${g.max_calls} ${g.max_calls===1?'call':'calls'} in all</p><p class="muted">Explorer and Critic only read. Worker can edit only the files you approved. They use this run’s model and private copy and work until it ends, with no limit on model requests, tool calls, output or time; stopping the run stops them. No background work, other helpers, commands or network.</p>${S.apiVersion<15?'<p class="notice error">Update DGC before approving helpers.</p>':''}</section>`;}
function specialistReceiptMarkup(v){if(!v)return '';return `<section class="section" aria-label="What the helpers said"><h3>What the helpers said</h3><p class="notice">This is the model’s opinion, not a checked finding or a test result. The test results below come from the commands themselves.</p><dl class="meta"><dt>Helper calls</dt><dd>${v.calls.length}</dd><dt>Model requests</dt><dd>${v.model_calls}</dd><dt>Tool calls (whole run)</dt><dd>${v.tool_calls}</dd></dl>${v.calls.map(c=>`<article class="entry"><h3>${esc(c.role[0].toUpperCase()+c.role.slice(1))} · ${esc(outcomeWords(c.status))}</h3><p class="goal">${esc(c.summary||'It didn’t say anything.')}</p><dl class="meta"><dt>Model</dt><dd>${esc(c.model)}</dd><dt>Model requests</dt><dd>${c.model_calls}</dd><dt>Tool calls</dt><dd>${c.tool_calls}</dd><dt>Tokens in / out</dt><dd>${c.usage.input_tokens.toLocaleString()} / ${c.usage.output_tokens.toLocaleString()}</dd></dl></article>`).join('')||'<p class="muted">No helpers were called.</p>'}<details><summary>Technical details</summary><dl class="meta"><dt>Request slots</dt><dd>${v.requests}</dd><dt>Connection attempts</dt><dd>${v.transport_attempts}</dd><dt>Output tokens set aside</dt><dd>${v.output_token_reservations.toLocaleString()}</dd></dl><p class="mono">${esc(v.policy_digest)}</p></details></section>`;}

function actionMarkup(action) {
  if(action.kind==='read_only')return '<p class="notice">It only reads the code. This doesn’t let it change files or run tests.</p>';
  return `<p class="notice">Runs once · no network · your files aren’t changed</p>${action.kind==='patch'?`<h3>Files it may change</h3><pre>${esc(action.write_paths.join('\n'))}</pre><p class="muted">Only these files, in a private copy. Nothing is merged or applied to your files.</p>`:''}${specialistGrantMarkup(action.specialists)}<h3>Test commands (${action.tests.length})</h3>${action.tests.map((test,i)=>`<article class="entry"><h3>Command ${i+1}</h3><pre>${esc(commandLine(test.argv))}</pre><p class="mono">Runs in: ${esc(test.cwd)}</p></article>`).join('')||'<p class="muted">No test commands.</p>'}<p class="muted">Tests read the prepared copy and can write only to a private scratch folder. It can run exactly these commands and nothing else, with no network.</p>${executionLimitsMarkup()}`;
}
// macOS (Seatbelt) has no per-process address-space limit or process namespace: memory, process
// count and scratch are sampled there, and the policy view says so rather than reuse Linux wording.
function seatbeltRunner(){return S.executionCapability?.available===true&&S.executionCapability.backend==='seatbelt';}
function executionLimitsMarkup(){
  return seatbeltRunner()?'<dl class="meta"><dt>Time per command</dt><dd>60 seconds</dd><dt>CPU per process</dt><dd>30 seconds</dd><dt>Memory, all processes</dt><dd>512 MB (checked every so often)</dd><dt>Output</dt><dd>64 KB</dd><dt>Processes</dt><dd>32 (checked every so often)</dd></dl><p class="muted">On macOS these are checked about every 50 ms rather than enforced exactly, so a quick spike can go over between checks. Scratch space is 64 MB.</p>':'<dl class="meta"><dt>Time per command</dt><dd>60 seconds</dd><dt>CPU per process</dt><dd>30 seconds</dd><dt>Memory per process</dt><dd>512 MB</dd><dt>Output</dt><dd>64 KB</dd><dt>Processes</dt><dd>32</dd></dl><p class="muted">Total memory is also checked every so often, so a quick spike can go over between checks. Scratch space is 64 MB.</p>';
}
function capabilityMarkup(){
  const c=S.executionCapability;
  return `<section class="section" aria-label="Running commands safely"><h3>Running commands safely</h3>${S.executionLoading?'<p role="status">Checking…</p>':c?`<p class="${c.available?'muted':'notice error'}">${c.available?'Commands can run in a sealed-off copy on this computer.':esc(c.reason||'Commands can’t run in a sealed-off copy on this computer.')}</p><p class="muted">${esc(c.platform)}${c.backend?' · '+esc(c.backend):''} · no network · code is read-only to tests</p>${c.available&&c.limitations?.length?`<p>Weaker protections on this computer:</p><ul>${c.limitations.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}`:'<p class="muted">Not checked yet.</p>'}${errorMarkup(S.executionError)}${button('check-execution','Check',S.executionLoading||!usable())}</section>`;
}
async function loadExecution(){
  if(S.executionLoading||!usable())return;const epoch=S.epoch;S.executionLoading=true;S.executionError='';render();
  try{const c=await send('get_pip_execution');if(epoch!==S.epoch)return;
    if(!record(c)||typeof c.available!=='boolean'||typeof c.platform!=='string'||![null,'bwrap','seatbelt'].includes(c.backend)||!(c.reason===null||typeof c.reason==='string')||c.network!==false||c.test_workspace!=='read_only'||!(c.limitations===undefined||Array.isArray(c.limitations)&&c.limitations.length<=12&&c.limitations.every(x=>typeof x==='string'&&x.length>0&&x.length<=1000))||(c.backend==='seatbelt'&&!c.limitations?.length)||!record(c.limits)||Object.entries({wall_seconds:60,cpu_seconds:30,memory_bytes:536870912,output_bytes:65536,processes:32}).some(([key,v])=>c.limits[key]!==v))throw new Error('This DGC reported limits this view doesn’t know. Update DGC.');
    S.executionCapability=c;
  }catch(error){if(epoch===S.epoch){S.executionCapability=null;S.executionError=errorText(error);}}
  finally{if(epoch===S.epoch){S.executionLoading=false;render();if(S.review)renderReview();}}
}
function personalHandoffForm(d,targets,target){
 return `<form id="handoff-form" class="section form"><h2>Share a result with another Pip</h2><p class="muted">From ${esc(d.sourceName)}. Choose exactly what to share. Its other messages, accounts and permissions stay private.</p>${field('handoffText','The part of the result to share',true)}<p class="muted">Keep or delete text from the saved result, but don’t add any. Nothing is shortened for you.</p><label for="handoffTarget">Share with</label><select id="handoffTarget" data-draft="handoffTarget"><option value="">Choose a Personal Pip</option>${targets.map(p=>`<option value="${esc(p.id)}"${p.id===draft.handoffTarget?' selected':''}>${esc(p.name)}${p.status==='paused'?' · paused':''}</option>`).join('')}</select>${targets.length?'':'<p>Create another Personal Pip before sharing this result.</p>'}${field('handoffTask','What should it do with it?',true)}<p class="muted">It uses its own model and the app reads you already approved for it. No messages are sent and no files are changed. You review this before it starts; approving it starts one task.</p><div class="actions"><button type="submit"${S.busy||!usable()||!target?' disabled':''}>Save for review</button>${button('cancel-handoff-draft','Cancel',S.busy)}</div></form>`;
}
function reviewPersonalHandoff(h,reject){
 const p=h.payload,pending=h.status==='pending';draft.findingReviewReason='';
 openReview({title:reject?'Reject this handoff?':pending?'Share with '+p.target.name+'?':'Shared result',description:'Only the text below is shared. Approving starts one task; it doesn’t change either Pip or give it new permissions.',body:`<h3>Shared result</h3><pre>${esc(p.source.text)}</pre><h3>Task for ${esc(p.target.name)}</h3><p>${esc(p.task)}</p><dl class="meta"><dt>${esc(p.target.name)}’s model</dt><dd>${esc(p.target.model)}</dd><dt>Expires</dt><dd>${esc(date(h.expires_at))}</dd><dt>Status</dt><dd>${esc(reviewStatusWords(h.status))}</dd></dl><h3>What ${esc(p.target.name)} already reads</h3>${p.target.app_plan?`${readList(p.target.app_plan)}<p class="muted">These reads may run for this task.</p>`:'<p>No app reads.</p>'}<p class="muted">No project files, browser, shell, sending or buying. The shared result is text another Pip wrote; it can’t give ${esc(p.target.name)} new permissions.</p>`,confirm:reject?'Reject handoff':'Approve and queue',reasonRequired:reject,note:'Note (optional)',autoReason:'Rejected in the Pips view.',readOnly:!pending,expiresAt:h.expires_at,blocked:!pending||S.apiVersion<30||remoteHost,request:{type:reject?'reject_pip_handoff':'accept_pip_handoff',handoff_id:h.id,expected_revision:h.revision}});
}
function submitPersonalHandoff(saved,target){
 const text=draft.handoffText,task=draft.handoffTask.trim();
 if(S.apiVersion<30||remoteHost||!personalPip()||!target||!personalPip(target)||target.status==='archived'||!text||new TextEncoder().encode(text).length>12000||!saved.text.includes(text)||!task||new TextEncoder().encode(task).length>4000){setError('Choose another Pip, share text taken from the result, and say what it should do. If either is very long, shorten it.');return;}
 const request={type:'propose_pip_personal_handoff',source_run_id:saved.runId,target_pip_id:target.id,shared_text:text,task},signature=JSON.stringify(request);
 if(saved.signature!==signature){saved.signature=signature;saved.key='editor-handoff-'+globalThis.crypto.randomUUID();}
 void mutate({...request,idempotency_key:saved.key},result=>{const h=handoffRecord(result.handoff,S.selected,S.workspace.id);if(h.payload.type!=='personal_result.v1'||h.source_run_id!==saved.runId||h.target_pip_id!==target.id||h.payload.source.text!==text||h.payload.task!==task)throw Error('The saved handoff doesn’t match what you chose. Refresh and try again.');S.handoffDraft=null;S.notice='Handoff saved. Nothing starts until you approve it.';reviewHandoff(h);void loadHandoffs();});
}
function handoffsMarkup(){
  const d=archived()?null:S.handoffDraft,targets=S.jobs.filter(p=>p.status!=='archived'&&p.id!==S.selected&&(personalPip()?personalPip(p):committedJob(p)&&!documentationPip(p))&&pipType(p,S.types)?.available&&(!d?.artifact||p.pip_type==='pulse')),target=targets.find(p=>p.id===draft.handoffTarget),kind=target?.pip_type==='patch'?'patch':target?.pip_type==='pulse'?'test':'read_only';
  const form=d?.personal?personalHandoffForm(d,targets,target):d?`<form id="handoff-form" class="section form"><h2>${d.artifact?'Hand the Patch changes to Pulse':'Hand off a finding'}</h2><p class="muted">From ${esc(d.sourceName)}${d.artifact?'':` · finding ${d.index+1}`}</p>${d.artifact?artifactSourceMarkup(d.artifact):`<h3>${esc(d.finding.title)}</h3><p class="mono">${esc(d.finding.path)}:${d.finding.line}</p><pre>${esc(d.finding.evidence)}</pre>`}<label for="handoffTarget">Hand to</label><select id="handoffTarget" data-draft="handoffTarget"><option value="">Choose a Pip</option>${targets.map(p=>`<option value="${esc(p.id)}"${p.id===draft.handoffTarget?' selected':''}>${esc(p.name)} · ${esc(pipType(p,S.types).name)}${p.status==='paused'?' · paused':''}</option>`).join('')}</select>${targets.length?'':'<p class="notice">Create another Pip in this project that can take this handoff first.</p>'}${field('handoffTask','What should it do?',true)}${kind==='patch'?`${field('handoffPaths','Files it may change, one per line',true)}<p class="muted">Exact file paths from the project folder, up to 32. No folders or wildcards. Changes stay in a private copy.</p>`:''}${kind==='patch'?specialistFormMarkup():''}${kind!=='read_only'?`${field('handoffTests','Test commands (JSON)',true)}<p class="muted">For example: [{"argv":["python3","-m","unittest"],"cwd":"."}]: each command is a list of arguments and the folder to run it in. Nothing goes through a shell. Up to four commands; Pulse needs at least one. You approve each one exactly as typed.</p>${capabilityMarkup()}`:'<p class="muted">It only reads the code. No files are changed and no tests are run.</p>'}<p class="muted">Saving doesn’t start anything or change the original report. Next you review exactly what it will read, which Pip and model will do it, and what it may change or run.</p><div class="actions"><button type="submit"${S.busy||!usable()||!target?' disabled':''}>Save for review</button>${button('cancel-handoff-draft','Cancel draft',S.busy)}</div></form>`:'';
  return `${form}<section class="section" aria-label="Handoff history"><div class="section-head"><h2>Handoffs</h2>${button('load-handoffs',S.handoffsLoading?'Loading…':S.handoffsLoaded?'Refresh handoffs':'Load handoffs',S.handoffsLoading||!usable())}</div><p class="muted">Work handed to or from this Pip. Each one waits up to seven days for your answer, even if you close the editor. Approving one starts one run.</p>${errorMarkup(S.handoffsError)}${S.handoffs.map(h=>`<article class="entry"><h3>${esc(handoffTitle(h.payload))}</h3><p>${esc(h.source_pip_id===S.selected?'To '+h.payload.target.name:'From '+pipName(h.source_pip_id))} · ${esc(reviewStatusWords(h.status))}${h.run_status?' · '+esc(personalStatusLabel(h.run_status)):''}</p><p class="goal">${esc(h.payload.task)}</p><p class="muted">Requested ${esc(requester(h.requested_by))} · Expires ${esc(date(h.expires_at))}</p><div class="actions"><button type="button" data-handoff="${esc(h.id)}">${h.status==='pending'?'Review handoff…':'View handoff'}</button>${h.status==='pending'?`<button type="button" data-reject-handoff="${esc(h.id)}">Reject…</button>`:''}${h.run_id?`<button type="button" data-lineage-pip="${esc(h.target_pip_id)}" data-lineage-run="${esc(h.run_id)}">Open its run</button>`:''}</div></article>`).join('')||(S.handoffsLoaded?`<p class="muted">No handoffs yet. ${personalPip()?'To hand a result to another Pip, open it in Results and choose Share with another Pip.':'To start one, open a finding in an audit report and choose Hand off to another Pip.'}</p>`:'')}${S.handoffCursor&&S.handoffs.length<200?button('more-handoffs','Older handoffs',S.handoffsLoading||!usable()):''}${S.handoffs.length>=200?'<p class="muted">Showing the latest 200.</p>':''}</section>`;
}
// Handoff rows name Pips and requesters the way people know them, never by stored ID.
function pipName(id){return S.jobs.find(p=>p.id===id)?.name||'another Pip';}
function requester(actor){const a=String(actor||'');return a==='editor-user'?'by you in the editor':a==='local-console'?'by you in the terminal':a.startsWith('main-')?'from the main chat':a.startsWith('core')?'by Core':'by another DGC surface';}
async function loadHandoffs(more=false){
  if(!usable()||!S.selected||S.handoffsLoading||(more&&(!S.handoffCursor||S.handoffs.length>=200)))return;
  const token=scope(),sequence=++handoffSeq,before=more?S.handoffCursor:null;S.handoffsLoading=true;S.handoffsError='';render();
  try{const page=handoffsPage(await send('list_pip_handoffs',{pip_id:S.selected,limit:20,...(before?{before_id:before}:{})}),S.selected,S.workspace.id);if(token!==scope()||sequence!==handoffSeq)return;
    if(more&&(page.next_before_id===before||page.handoffs.some(h=>S.handoffs.some(old=>old.id===h.id))))throw new Error('Older handoffs didn’t load. Refresh to try again.');
    S.handoffs=more?[...S.handoffs,...page.handoffs]:page.handoffs;S.handoffCursor=page.next_before_id;S.handoffsLoaded=true;
  }catch(error){if(token===scope()&&sequence===handoffSeq)S.handoffsError=errorText(error);}
  finally{if(token===scope()&&sequence===handoffSeq){S.handoffsLoading=false;render();}}
}
function reviewHandoff(h,reject=false){
  if(h.payload.type==='personal_result.v1'){reviewPersonalHandoff(h,reject);return;}
  const p=h.payload,privileged=p.action.kind!=='read_only',pending=h.status==='pending';
  draft.findingReviewReason='';
  openReview({title:reject?'Reject this handoff?':pending?'Approve this handoff?':'Handoff',description:reject?'Nothing runs, and the original report stays as it is.':pending?`This starts one run of ${p.target.name} with exactly what’s below. It gives no lasting permission and doesn’t change ${p.target.name}.`:'What was handed off, and the answer.',body:`${p.type==='patch_artifact.v1'?artifactSourceMarkup(p.source):`<h3>${esc(handoffTitle(p))}</h3><p class="mono">${esc(p.source.path)}:${p.source.line}</p><pre>${esc(p.source.evidence)}</pre>`}<dl class="meta"><dt>From</dt><dd>${esc(pipName(h.source_pip_id))}</dd><dt>Commit</dt><dd class="mono">${esc(p.source.source_revision)}</dd>${p.source.review_status?`<dt>Finding</dt><dd>${esc(p.source.review_status==='accepted'?'Accepted':p.source.review_status==='dismissed'?'Dismissed':'Not decided')}</dd>`:''}<dt>To</dt><dd>${esc(p.target.name)} · ${esc(pipType({pip_type:p.target.pip_type},S.types)?.name||p.target.pip_type)}</dd><dt>Model</dt><dd>${esc(p.target.model)}</dd><dt>Branch or commit</dt><dd>${esc(p.target.source_ref)}</dd><dt>Asked</dt><dd>${esc(requester(h.requested_by))}</dd><dt>Expires</dt><dd>${esc(date(h.expires_at))}</dd><dt>Status</dt><dd>${esc(reviewStatusWords(h.status))}</dd>${h.resolved_by?`<dt>Answered</dt><dd>${esc(requester(h.resolved_by))} · ${esc(date(h.resolved_at))}</dd>`:''}</dl><h3>Task</h3><p class="goal">${esc(p.task)}</p>${actionMarkup(p.action)}${privileged?capabilityMarkup():''}<details><summary>Technical details</summary><p class="mono">Handoff ${esc(h.payload_digest)}</p><p class="mono">Permissions ${esc(p.action_digest)}</p></details>${h.resolution_reason?`<p class="muted">${esc(h.resolution_reason)}</p>`:''}`,confirm:reject?'Reject handoff':'Approve and queue',reasonRequired:reject,note:'Note (optional)',autoReason:'Rejected in the Pips view.',readOnly:!pending,expiresAt:h.expires_at,blocked:!pending,requiresExecution:!reject&&privileged,requiresSpecialists:!reject&&!!p.action.specialists,request:{type:reject?'reject_pip_handoff':'accept_pip_handoff',handoff_id:h.id,expected_revision:h.revision}});
}
async function openSavedHandoff(id,reject=false){
  const token=scope(),sequence=++handoffDetailSeq;
  try{const result=await send('get_pip_handoff',{handoff_id:id});if(token!==scope()||sequence!==handoffDetailSeq)return;
    const h=handoffRecord(result.handoff,S.selected,S.workspace.id);if(h.id!==id)throw new Error('That handoff didn’t load. Refresh to try again.');
    if(['patch','test'].includes(h.payload.action.kind)&&!reject)await loadExecution();
    if(token===scope()&&sequence===handoffDetailSeq)reviewHandoff(h,reject);
  }catch(error){if(token===scope()&&sequence===handoffDetailSeq)setError(error);}
}
async function openLineage(pip,run){
  if(!S.jobs.some(p=>p.id===pip)){setError('That Pip isn’t in this project.');return;}
  const selecting=select(pip),token=scope();await selecting;if(token!==scope()||S.selected!==pip)return;S.tab='runs';rememberView();await loadRun(run);
}
function savedProposalsMarkup() {
  const p=S.pip;
  return `<section class="section"><h2>Waiting changes</h2><p class="muted">Changes wait up to 7 days. Accepting one sets aside older ones.${pulsePip(p)?' Check the exact commands and schedule before you accept.':''}</p>${p.proposals?.length?p.proposals.map(v=>`<article class="proposal"><h3>${esc(changeSummary(v))}</h3><p class="goal">${esc(v.definition?.goal)}</p><p>${esc(scheduleLabel(v.definition?.schedule))}</p>${v.definition?.event_trigger?`<p>${esc(eventTriggerLabel(v.definition.event_trigger))}</p>`:''}<p class="muted">${esc(v.reason||'No reason given.')}</p><p class="muted">Asked ${v.actor?esc(requester(v.actor)):'by someone not recorded'} · ${esc(approvalStatus(v.approval_status||'pending'))}${v.expires_at?` · Expires ${esc(date(v.expires_at))}`:' · No expiry recorded'}</p><div class="actions"><button type="button" data-proposal="${esc(v.id)}"${S.busy||!usable()?' disabled':''}>Review…</button><button type="button" data-reject="${esc(v.id)}"${S.busy||!usable()?' disabled':''}>Turn down…</button></div></article>`).join(''):'<p class="muted">Nothing is waiting.</p>'}</section>`;
}
function approvalsMarkup() {
  const capped=S.approvals.length>=200;
  return `<section class="section" aria-label="Review history"><div class="section-head"><h2>Review history</h2>${button('load-approvals',S.approvalsLoading?'Loading…':S.approvalsLoaded?'Refresh':'Load history',S.busy||!usable()||S.approvalsLoading)}</div><p class="muted">Every change you accepted or turned down.</p>${errorMarkup(S.approvalsError)}${S.approvals.map(a=>`<article class="approval"><span class="badge">${esc(approvalStatus(a.status))}</span><h3>${esc(a.action_summary)}</h3><p class="muted">${a.expected_version===0?'Created the Pip':(a.action_type==='schedule_update'?'Schedule change':'Change')+' to version '+a.expected_version}</p><dl class="meta"><dt>Asked</dt><dd>${esc(requester(a.requested_by))}</dd><dt>Created</dt><dd>${esc(date(a.created_at))}</dd><dt>Expires</dt><dd>${esc(date(a.expires_at))}</dd>${a.resolved_at?`<dt>Answered</dt><dd>${esc(date(a.resolved_at))}${a.resolved_by?` · ${esc(requester(a.resolved_by))}`:''}</dd>`:''}</dl>${a.status==='pending'&&S.pip?.proposals?.some(p=>p.id===a.proposal_id)?`<button type="button" data-proposal="${esc(a.proposal_id)}"${S.busy||!usable()?' disabled':''}>Review…</button>`:''}</article>`).join('')|| (S.approvalsLoaded?'<p class="muted">Nothing yet.</p>':'')}${S.approvalCursor&&!capped?button('more-approvals','Older reviews',S.busy||!usable()||S.approvalsLoading):''}${capped?'<p class="notice">Showing the latest 200.</p>':''}</section>`;
}
async function loadApprovals(more=false) {
  if(!S.pip||!usable()||S.approvalsLoading||(more&&(!S.approvalCursor||S.approvals.length>=200)))return;
  const token=scope(),sequence=++approvalSeq,prior=more?S.approvalCursor:null;
  S.approvalsLoading=true;S.approvalsError='';render();
  try {
    const result=await send('list_pip_approvals',{pip_id:S.selected,limit:20,...(prior?{before_id:prior}:{})});
    if(token!==scope()||sequence!==approvalSeq)return;
    const page=approvalsPage(result,S.selected);
    if(prior&&page.next_before_id===prior)throw new Error('Older reviews didn’t load. Refresh to try again.');
    if(more&&page.approvals.some(a=>S.approvals.some(p=>p.id===a.id)))throw new Error('Older reviews didn’t load. Refresh to try again.');
    S.approvals=more?[...S.approvals,...page.approvals]:page.approvals;S.approvalCursor=page.next_before_id;S.approvalsLoaded=true;
  }catch(error){if(token===scope()&&sequence===approvalSeq)S.approvalsError=errorText(error);}
  finally{if(token===scope()&&sequence===approvalSeq){S.approvalsLoading=false;render();}}
}
function revisionsMarkup() {
  const p=S.pip;
  return `${archived()?'<section class="section"><h2>Archived</h2><p class="muted">Restore it in Settings to change it.</p></section>':`${savedProposalsMarkup()}<form id="revision-form" class="section form"><h2>Change what it does</h2>${field('revisionGoal','What should it do?',true)}<button type="submit" class="primary"${S.busy||!usable()?' disabled':''}>Save</button></form>`}<section class="section"><div class="section-head"><h2>Version history</h2>${button('load-history',S.historyLoaded?'Refresh history':'Load history',S.busy||!usable())}</div>${S.versions.map(v=>`<article class="version"><h3>Version ${esc(v.version)} <span class="muted">· ${esc(date(v.created_at))}</span></h3><p class="goal">${esc(v.definition?.goal)}</p><p class="muted">${esc(v.reason)} · ${esc(requester(v.actor))}</p><small>${esc(v.definition?.source_ref)} · ${esc(scheduleLabel(v.definition?.schedule))}</small></article>`).join('')}${S.cursor!==null?button('more-history','Older versions',S.busy||!usable()):''}</section>${approvalsMarkup()}`;
}

function resetOutcomes(){resetCommandReceipts();notificationSeq++;notifications=null;notificationItems=[];notificationLoading=false;notificationError='';notificationMark='';outcomeSessionSeq++;outcomeSeq++;outcomeInspectSeq++;outcomeReviewSeq++;outcomeSessions=[];outcomeSessionsCursor='';outcomeSessionsMore=false;outcomeSessionsLoaded=false;outcomeSessionsLoading=false;outcomeSessionsError='';outcomeHistory=[];outcomeCursor=null;outcomeLoaded=false;outcomeLoading=false;outcomeError='';outcomeInspection=null;outcomeInspecting=false;outcomeRetry=null;draft.outcomeSession='';draft.outcomeTitle='';draft.outcomeText='';draft.outcomeSourceKind='commit';draft.outcomeSourceValue='';}
function sessionStatementDetails(p,digest){return `<details><summary>Technical details</summary><dl class="meta"><dt>Session</dt><dd class="mono">${esc(p.session.id)}</dd><dt>Session version</dt><dd>${p.session.revision}</dd><dt>Session SHA-256</dt><dd class="mono">${esc(p.session.sha256)}</dd><dt>Bytes</dt><dd>${p.session.bytes}</dd><dt>Statement SHA-256</dt><dd class="mono">${esc(digest)}</dd><dt>Linked to</dt><dd class="mono">${esc(p.source_reference.selection.kind==='pip_run'?p.source_reference.selection.run_id:p.source_reference.selection.revision)}</dd>${pinnedSourceMarkup(p.source_reference)}</dl>${pinnedSourceNotice(p.source_reference)}<p class="muted">The session is fingerprinted on this computer; none of the chat goes into the statement. The commit or run you link is just a pointer, not proof that a command used it.</p></details>`;}
function outcomesMarkup(){
 if(S.apiVersion<12)return '<section class="section"><h3>Session statements</h3><p class="muted">Update DGC to add a statement from a saved session. Your context is still here.</p></section>';
 const inspected=outcomeInspection?.id===draft.outcomeSession?outcomeInspection:null;
 return `<section class="section" aria-label="Session statement history"><div class="section-head"><h3>Session statements</h3>${button('load-outcomes',outcomeLoading?'Loading…':'Refresh',!usable()||outcomeLoading)}</div><p class="muted">Things you wrote about a DGC session, for future runs to know. They aren’t checked against anything that ran. Adding one never starts a Pip or changes permissions.</p>${errorMarkup(outcomeError)}${outcomeHistory.map(p=>`<article class="entry"><span class="badge">${esc(reviewStatusWords(p.status))}</span><h4>${esc(p.title)}</h4><p class="muted">${esc(date(p.created_at))}</p><div class="actions"><button type="button" data-outcome="${esc(p.id)}"${S.busy||!usable()?' disabled':''}>${p.status==='pending'?'Review statement…':'View statement'}</button>${p.status==='pending'?`<button type="button" data-reject-outcome="${esc(p.id)}"${S.busy||!usable()?' disabled':''}>Reject statement…</button>`:''}</div></article>`).join('')}${outcomeLoaded&&!outcomeHistory.length?'<p class="muted">No session statements yet.</p>':''}${outcomeCursor&&outcomeHistory.length<100?button('more-outcomes','Older statements',outcomeLoading||!usable()):''}${outcomeCursor&&outcomeHistory.length>=100?'<p class="muted">Showing the latest 100.</p>':''}</section><form id="outcome-form" class="section form"><h3>Add a session statement</h3><p class="notice">You write it. DGC doesn’t rerun tests or treat the model’s replies as proof. You review the exact text before it’s added to context.</p><label for="outcomeSession">Saved session</label><select id="outcomeSession" data-draft="outcomeSession"><option value="">Choose a saved session</option>${outcomeSessions.map(row=>`<option value="${esc(row.session_id)}"${row.session_id===draft.outcomeSession?' selected':''}>${esc(row.session_id)} · ${esc(date(row.updated_at))}</option>`).join('')}</select><div class="actions">${button('load-outcome-sessions',outcomeSessionsLoading?'Loading…':'Refresh sessions',!usable()||outcomeSessionsLoading)}${outcomeSessionsMore&&outcomeSessions.length<100?button('more-outcome-sessions','More sessions',!usable()||outcomeSessionsLoading):''}${button('inspect-outcome-session',outcomeInspecting?'Checking…':'Check this session',!usable()||S.busy||outcomeInspecting||!draft.outcomeSession)}</div>${errorMarkup(outcomeSessionsError)}${outcomeSessionsLoaded&&!outcomeSessions.length?'<p class="muted">No saved DGC sessions for this project yet. Save a DGC session on this computer first.</p>':''}${outcomeSessionsMore&&outcomeSessions.length>=100?'<p class="muted">Showing the latest 100 sessions.</p>':''}${inspected?`<p class="muted">Checked: version ${inspected.revision} · ${inspected.bytes} bytes. The chat stays on this computer. If the session changes, check it again.</p>`:''}<label for="outcomeSourceKind">Link it to</label><select id="outcomeSourceKind" data-draft="outcomeSourceKind"><option value="commit"${draft.outcomeSourceKind==='commit'?' selected':''}>A commit</option><option value="pip_run"${draft.outcomeSourceKind==='pip_run'?' selected':''}>A finished Pip run</option></select>${field('outcomeSourceValue',draft.outcomeSourceKind==='commit'?'Full commit hash':'Run ID')}${draft.outcomeSourceKind==='pip_run'&&S.run?.status==='succeeded'?button('use-outcome-run','Use the run that’s open',S.busy):''}${field('outcomeTitle','Title')}${field('outcomeText','Your statement',true)}<p class="muted">Keep the title short and the statement to a paragraph or two. The link is a pointer only; it doesn’t prove the session used that code.</p><button type="submit"${S.busy||!usable()||!S.context||!inspected?' disabled':''}>Save for review…</button></form>`;
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
 sessionStatement(p,S.workspace.id);const pending=p.status==='pending';openReview({title:reject?'Reject this session statement?':pending?'Add this statement to context?':'Session statement',readOnly:!pending,blocked:!pending||!S.context,description:'You wrote this. It wasn’t checked against anything that ran, and the commit or run it links to is only a pointer. It gives no Pip any tools or permissions.',body:`<h3>${esc(p.title)}</h3><p class="goal">${esc(p.statement)}</p><dl class="meta"><dt>Saved</dt><dd>${esc(requester(p.created_by))}</dd><dt>Status</dt><dd>${esc(reviewStatusWords(p.status))}</dd></dl>${sessionStatementDetails(p,p.digest)}<p class="muted">${reject?'Nothing is added to context and nothing runs.':'DGC checks the session, the link and the context again before adding it. If anything changed, check the session and write it again.'}</p>`,confirm:reject?'Reject statement':'Add to context',request:{type:reject?'reject_workspace_session_outcome':'accept_workspace_session_outcome',workspace_id:S.workspace.id,proposal_id:p.id,expected_digest:p.digest,...(reject?{}:{expected_context_revision:S.context?.revision})}});
}
async function openOutcome(id,reject=false){
 if(S.apiVersion<12||!usable()||S.busy)return;const token=scope(),sequence=++outcomeReviewSeq;
 try{const answer=await send('get_workspace_session_outcome',{workspace_id:S.workspace.id,proposal_id:id});if(token!==scope()||sequence!==outcomeReviewSeq)return;if(answer.workspace_id!==S.workspace.id)throw Error('The saved statement belongs to another workspace.');const p=sessionStatement(answer.proposal,S.workspace.id);if(p.id!==id)throw Error('The saved statement identity changed.');reviewOutcome(p,reject);}catch(error){if(token===scope()&&sequence===outcomeReviewSeq)setError(error);}
}

function memorySourceMarkup(source){
 const f=source.finding;return `<h3>${esc(f.title)}</h3><p class="mono">${esc(f.path)}:${f.line}</p><pre>${esc(f.evidence)}</pre><p class="muted">${esc(f.severity)} · The quoted code was checked; the model’s conclusion wasn’t.</p><details data-details="memory-source-${esc(source.run_id)}-${source.finding_index}"><summary>Technical details</summary><dl class="meta"><dt>Run</dt><dd class="mono">${esc(source.run_id)}</dd><dt>Audit / finding</dt><dd>${source.checkpoint_id} / ${source.finding_index+1}</dd><dt>Version</dt><dd>${source.job_version}</dd>${pinnedSourceMarkup(source)}<dt>Context then</dt><dd>${source.context_reference?`${source.context_reference.revision} · ${esc(source.context_reference.digest)}`:'Not recorded'}</dd><dt>Finding fingerprint</dt><dd class="mono">${esc(source.finding_identity)}</dd><dt>Finding ID</dt><dd class="mono">${esc(source.finding_id)}</dd></dl>${pinnedSourceNotice(source)}</details>`;
}
function memoryRecordMarkup(m,readOnly=false,asOf=null){const expired=m.status==='active'&&m.expires_at!==null&&Date.parse(m.expires_at)<=(asOf===null?Date.now():Date.parse(asOf));const status=m.status==='revoked'?'Removed':expired?'Expired':'In use';return `<article class="entry"><span class="badge">${status}${asOf===null?'':' when the run started'}</span>${memorySourceMarkup(m.source)}<h3>Why it’s fine</h3><p class="goal">${esc(m.reason)}</p><p class="muted">${esc(requester(m.created_by))} · ${esc(date(m.created_at))} · ${m.expires_at?`Expires ${esc(date(m.expires_at))}`:'Doesn’t expire'}</p>${m.status==='revoked'?`<p class="goal">${esc(m.revoke_reason)}</p><p class="muted">Removed ${esc(requester(m.revoked_by))} · ${esc(date(m.revoked_at))}</p>`:''}<details><summary>Technical details</summary><p class="mono">${esc(m.id)}</p><p class="mono">${esc(m.digest)}</p></details>${!readOnly&&m.status==='active'?`<button type="button" data-revoke-memory="${esc(m.id)}"${S.busy||!usable()?' disabled':''}>Remove exception…</button>`:''}</article>`;}
function memoriesMarkup(){if(S.apiVersion<14)return '<section class="section"><h2>Pip memory</h2><p>Update DGC to see this Pip’s exceptions.</p></section>';return `<section class="section" aria-label="Pip memory"><div class="section-head"><h2>Pip memory</h2>${button('load-memories',memoryLoading?'Loading…':'Refresh',memoryLoading||!usable())}</div><p class="muted">${personalPip()?`Notes you’ve asked ${esc(S.pip?.name||'this Pip')} to keep in mind. They never give it new access.`:'Findings you told this Pip are fine. Its audits and chats know about them; they never hide findings or give it new permissions.'}</p><details data-details="memory-explainer"${personalPip()?' hidden':''}><summary>How exceptions work</summary><p class="muted">${PIP_MEMORY_NOTICE}</p><p class="muted">To add one, open a finding in an audit report and choose Add exception. Audits and chats with this Pip see them; drafts, Patch and Pulse runs don’t. Changes here affect only runs that start later.</p></details>${errorMarkup(memoryError)}${memories.map(m=>memoryRecordMarkup(m)).join('')}${memoryLoaded&&!memories.length?'<p class="muted">No exceptions yet.</p>':''}${memoryCursor!==null&&memories.length<100?button('more-memories','Older exceptions',memoryLoading||!usable()):''}${memoryCursor!==null&&memories.length>=100?'<p class="muted">Showing 100. Refresh to go back to the latest.</p>':''}<p class="muted">${S.apiVersion>=19?'Exceptions and the claims and preferences below share one limit.':'Up to 32 exceptions in use per Pip.'} Expired and removed ones stay listed.</p></section>`;}
function typedMemoryPinMarkup(pin){
 const labels={finding_exception:'Exceptions',fact:'Claims',preference:'Preferences'},source={not_observed:'No linked audit',same_pinned_source:'Same code',historical_source:'Older code'},job={same_pinned_job:'same setup',historical_job:'older setup'},context={not_recorded:'context not recorded',same_pinned_context:'same context',historical_context:'older context'};
 return `<details data-details="memory-pin" aria-label="Memory it had"><summary>Memory it had when it started · ${pin.entries.length} included</summary><p class="muted">${PIP_STATEMENT_NOTICE}</p><p class="muted">As of ${esc(date(pin.as_of))}. Some may have expired or been removed since. Matching code or setup doesn’t mean a claim is true or still relevant.</p><ul>${Object.entries(pin.counts_by_kind).map(([kind,c])=>`<li>${labels[kind]}: ${c.eligible_records-c.omitted_records} included · ${c.omitted_records} left out (too long) · ${c.revoked_records} removed · ${c.expired_records} expired</li>`).join('')}</ul><p class="muted">Leaving one out doesn’t mean it was resolved. Memory shows what’s in use now.</p>${pin.entries.map(e=>`<div><p class="muted">${source[e.applicability.source]} · ${job[e.applicability.job]} · ${context[e.applicability.context]}</p>${e.memory.kind==='finding_exception'?memoryRecordMarkup(e.memory,true,pin.as_of):statementRecordMarkup(e.memory,'active',pin.as_of,true,true)}</div>`).join('')}<details><summary>Technical details</summary><p class="mono">Context ${pin.context_reference.revision} · ${esc(pin.context_reference.digest)}</p><p class="mono">${esc(pin.digest)}</p></details></details>`;
}
function memoryPinMarkup(run){
 if(run.manifest?.pip_memory===undefined)return '';
 try{const pin=pipMemoryPin(run.manifest.pip_memory,{...run,workspace_id:run.workspace_id||S.workspace.id});if(pin.schema_version===2)return typedMemoryPinMarkup(pin);return `<details data-details="memory-pin" aria-label="Memory it had"><summary>Memory it had when it started · ${pin.entries.length} included</summary><p class="muted">${PIP_MEMORY_NOTICE}</p><p class="muted">As of ${esc(date(pin.as_of))}: ${pin.eligible_records-pin.omitted_records} included · ${pin.omitted_records} left out (too long) · ${pin.revoked_records} removed · ${pin.expired_records} expired.</p><p class="muted">Some may have been removed or expired since; Memory shows what’s in use now. Leaving one out doesn’t mean it was resolved.</p>${pin.entries.map(e=>`<div><span class="badge">${esc(({exact_source_and_job:'Same code and setup',historical_source:'Older code',historical_job:'Older setup',historical_source_and_job:'Older code and setup'})[e.applicability])}</span>${memoryRecordMarkup(e.memory,true,pin.as_of)}</div>`).join('')}</details>`;}catch(error){return errorMarkup(errorText(error));}
}
async function loadMemories(more=false){
 if(!usable()||S.apiVersion<14||!S.selected||memoryLoading)return;const token=scope(),seq=++memorySeq,before=more?memoryCursor:null;memoryLoading=true;memoryError='';render();
 try{const page=pipMemoriesPage(await send('list_pip_memories',{pip_id:S.selected,limit:20,...(before!==null?{before_id:before}:{})}),S.selected,S.workspace.id);if(token!==scope()||seq!==memorySeq)return;if(more&&(page.memories.some(m=>memories.some(old=>old.id===m.id))||page.next_before_id!==null&&page.next_before_id>=before))throw Error('Older exceptions didn’t load. Refresh to try again.');memories=more?[...memories,...page.memories]:page.memories;memoryCursor=page.next_before_id;memoryLoaded=true;}
 catch(error){if(token===scope()&&seq===memorySeq)memoryError=errorText(error);}finally{if(token===scope()&&seq===memorySeq){memoryLoading=false;render();}}
}
async function reviewException(index){
 if(!usable()||S.apiVersion<14||S.busy||S.run?.status!=='succeeded')return;const token=scope(),seq=++memorySourceSeq,run=S.run;
 try{const checkpoint=runCheckpoint(run.checkpoint,{id:run.id,pip_id:S.selected,workspace_id:S.workspace.id}),finding=checkpoint?.findings[index];if(!finding)return;const c=pipExceptionCandidate(await send('get_pip_exception_source',{pip_id:S.selected,run_id:run.id,finding_index:index}),S.selected,S.workspace.id);if(token!==scope()||seq!==memorySourceSeq||S.runId!==run.id)return;
 const source=c.source;if(source.run_id!==run.id||source.checkpoint_id!==checkpoint.id||source.finding_index!==index||source.finding_id!==finding.finding_id||source.finding_identity!==finding.identity||source.finding_review_revision!==finding.review.revision||!pipExceptionSourceEqual(source,{...source,job_version:run.manifest.job_version,source_policy:sourcePolicy(run.manifest.source_policy),source_revision:run.manifest.source_revision,source_snapshot:run.manifest.source_snapshot??null,context_reference:checkpoint.context_revision===null?null:{revision:checkpoint.context_revision,digest:checkpoint.context_digest}})||['title','severity','path','line','evidence','verification'].some(k=>source.finding[k]!==finding[k]))throw Error('The finding changed while this was loading. Refresh the report and try again.');
 draft.findingReviewReason='';draft.memoryExpiry='';openReview({title:'Add an exception?',description:PIP_MEMORY_NOTICE,body:memorySourceMarkup(source),confirm:'Add exception',reasonRequired:true,note:'Why this is fine (optional)',autoReason:'Accepted as an exception in the Pips view.',memoryRecord:true,memorySource:source,request:{type:'record_pip_exception',pip_id:S.selected,run_id:run.id,finding_index:index,expected_source_digest:c.digest}});
 }catch(error){if(token===scope()&&seq===memorySourceSeq)setError(error);}
}
function revokeMemoryReview(id){if(S.apiVersion<14||!usable())return;const m=memories.find(m=>m.id===id);if(!m||m.status!=='active')return;draft.findingReviewReason='';openReview({title:'Remove this exception?',description:'Audits and chats that start from now on won’t see it. Runs that already started keep what they had. Your decisions on findings and the workspace context don’t change.',body:memoryRecordMarkup(m,true),confirm:'Remove exception',reasonRequired:true,autoReason:'Removed in the Pips view.',request:{type:'revoke_pip_exception',pip_id:S.selected,memory_id:m.id,expected_revision:m.revision}});}

function statementAnchorMarkup(a,digest){
 const s=a.source_reference;return `<p class="notice">${s?'Linked to an earlier audit. That doesn’t prove this statement.':'Not linked to any audit.'}</p>${s?`<dl class="meta"><dt>Audit</dt><dd class="mono">${esc(s.run_id)}</dd><dt>Version</dt><dd>${s.job_version}</dd>${pinnedSourceMarkup(s)}</dl>${pinnedSourceNotice(s)}`:''}<details><summary>Technical details</summary><dl class="meta"><dt>Pip</dt><dd class="mono">${esc(a.pip_id)}</dd><dt>Workspace</dt><dd class="mono">${esc(a.workspace_id)}</dd><dt>Job / lifecycle at review</dt><dd>v${a.job_version} / v${a.lifecycle_revision}</dd><dt>Context at recording review</dt><dd>v${a.context_reference.revision} · ${esc(a.context_reference.digest)}</dd><dt>Job definition digest</dt><dd class="mono">${esc(a.job_digest)}</dd><dt>Runner / binding</dt><dd class="mono">${esc(a.binding.runner_id)} / ${esc(a.binding.binding_id)}</dd><dt>Binding observed</dt><dd>${esc(date(a.binding.updated_at))}</dd><dt>Binding root digest</dt><dd class="mono">${esc(a.binding.root_digest)}</dd>${s?`<dt>Checkpoint</dt><dd>${s.checkpoint_id} · ${esc(s.checkpoint_digest)}</dd><dt>Checkpoint digest basis</dt><dd>Original stored checkpoint bytes</dd><dt>Audit context</dt><dd>v${s.context_reference.revision} · ${esc(s.context_reference.digest)}</dd>`:''}<dt>Reviewed anchor digest</dt><dd class="mono">${esc(digest)}</dd></dl><p class="muted">These fingerprints identify the saved records. They don’t check the claim or describe the code as it is now.</p></details>`;
}
function statementRecordMarkup(m,status,asOf,readOnly=false,atQueue=false){
 return `<article class="entry"><span class="badge">${m.kind==='fact'?'Claim':'Preference'} · ${esc(({active:'In use',expired:'Expired',revoked:'Removed'})[status]||status)}${atQueue?' when the run started':''}</span><h3>${esc(m.title)}</h3><p class="goal">${esc(m.statement)}</p><p class="muted">${m.kind==='fact'?'Something you told it; it may be wrong.':'A preference; it doesn’t change what the Pip is set up to do.'} Nothing here was checked against a run.</p><p class="goal">Why: ${esc(m.reason)}</p><p class="muted">${esc(requester(m.created_by))} · ${esc(date(m.created_at))}. ${m.expires_at?`Expires ${esc(date(m.expires_at))}.`:'Doesn’t expire.'} ${atQueue?'Status when the run started':'Status as of'} ${esc(date(asOf))}.</p>${m.status==='revoked'?`<p class="goal">Removed: ${esc(m.revoke_reason)}</p><p class="muted">${esc(requester(m.revoked_by))} · ${esc(date(m.revoked_at))}</p>`:''}${statementAnchorMarkup(m.anchor,m.anchor_digest)}<details><summary>IDs</summary><p class="mono">${esc(m.id)}</p><p class="mono">${esc(m.digest)}</p></details>${!readOnly&&m.status==='active'?`<button type="button" data-revoke-statement="${esc(m.id)}"${S.busy||!usable()?' disabled':''}>Remove…</button>`:''}</article>`;
}
function statementsMarkup(){
 if(S.apiVersion<19)return '';const sources=S.runs.filter(r=>r.status==='succeeded'&&(!r.manifest?.run_kind||r.manifest.run_kind==='audit'));const c=statementPage?.counts;
 return `<section class="section" aria-label="Recorded claims and preferences"><div class="section-head"><h2>Claims and preferences</h2>${button('load-statements',statementLoading?'Loading…':'Refresh',statementLoading||!usable())}</div><p class="muted">${PIP_STATEMENT_NOTICE}</p>${archived()?'<p class="muted">Archived: you can still see and remove these. Restore it in Settings to add new ones.</p>':`<details data-details="new-pip-statement"><summary>Add a claim or preference</summary><form id="pip-statement-form" class="form"><label for="statementKind">Kind</label><select id="statementKind" data-draft="statementKind"><option value="fact"${draft.statementKind==='fact'?' selected':''}>Claim</option><option value="preference"${draft.statementKind==='preference'?' selected':''}>Preference</option></select>${field('statementTitle','Title')}${field('statementText','Statement',true)}<label for="statementSource">Link to an audit (optional)</label><select id="statementSource" data-draft="statementSource"><option value="">No audit</option>${draft.statementSource&&!sources.some(r=>r.id===draft.statementSource)?`<option value="${esc(draft.statementSource)}" selected>An audit not loaded here · refresh first</option>`:''}${sources.map(r=>`<option value="${esc(r.id)}"${draft.statementSource===r.id?' selected':''}>Audit · ${esc(date(r.created_at))}</option>`).join('')}</select><p class="muted">Only this Pip’s finished audits shown in Runs are listed. Linking one doesn’t mean it supports what you wrote.</p><label for="statementExpiry">Expires (optional, with time zone)</label><input id="statementExpiry" data-draft="statementExpiry" value="${esc(draft.statementExpiry)}" placeholder="2026-12-01T09:00:00Z"><button type="submit"${statementInspecting||S.busy||!usable()?' disabled':''}>${statementInspecting?'Loading…':'Review…'}</button></form></details>`}${errorMarkup(statementError)}${c?`<p class="muted">${c.active} in use · ${c.expired} expired · ${c.revoked} removed, as of ${esc(date(statementPage.as_of))}.</p>`:''}${statementRows.map(e=>statementRecordMarkup(e.memory,e.effective_status,e.asOf)).join('')}${statementLoaded&&!statementRows.length?'<p class="muted">No claims or preferences yet.</p>':''}${statementPage?.page_reduced_for_budget?'<p class="muted">Fewer are shown on this page to keep it small; each one is complete.</p>':''}${statementPage?.has_more&&statementRows.length<100?button('more-statements','Older ones',statementLoading||!usable()):''}${statementPage?.has_more&&statementRows.length>=100?'<p class="muted">Showing 100. Refresh to go back to the latest.</p>':''}<p class="muted">Exceptions, claims and preferences share one limit: 32 in use per Pip. Removed and expired ones stay listed.</p></section>`;
}
async function loadStatements(more=false){
 if(S.apiVersion<19||!usable()||!S.selected||statementLoading)return;const token=scope(),seq=++statementSeq,before=more?statementPage?.next_before_id:null;statementLoading=true;statementError='';render();
 try{const page=pipStatementsPage(await send('list_pip_statements',{pip_id:S.selected,limit:20,...(before?{before_id:before}:{})}),S.selected,S.workspace.id);if(token!==scope()||seq!==statementSeq)return;if(more&&(page.entries.some(e=>statementRows.some(old=>old.memory.id===e.memory.id))||page.next_before_id!==null&&page.next_before_id>=before))throw Error('Older ones didn’t load. Refresh to try again.');const rows=page.entries.map(e=>({...e,asOf:page.as_of}));statementRows=more?[...statementRows,...rows]:rows;statementPage=page;statementLoaded=true;}
 catch(error){if(token===scope()&&seq===statementSeq)statementError=errorText(error);}finally{if(token===scope()&&seq===statementSeq){statementLoading=false;render();}}
}
function statementFormValue(){return pipStatementDraft({kind:draft.statementKind,title:draft.statementTitle.trim(),statement:draft.statementText.trim(),reason:draft.statementReason.trim()||'Recorded in the Pips view.',expiry:draft.statementExpiry.trim(),source_run_id:draft.statementSource});}
async function reviewStatement(){
 if(S.apiVersion<19||!usable()||!S.pip||archived()||S.busy||statementInspecting)return;const token=scope(),seq=++statementAnchorSeq;
 try{const authored=statementFormValue();if(authored.source_run_id&&!S.runs.some(r=>r.id===authored.source_run_id&&r.status==='succeeded'&&(!r.manifest?.run_kind||r.manifest.run_kind==='audit')))throw Error('Refresh and choose a finished audit of this Pip, or choose No audit.');const signature=JSON.stringify(authored);statementInspecting=true;S.error='';render();
  const candidate=pipStatementCandidate(await send('get_pip_statement_anchor',{pip_id:S.selected,...(authored.source_run_id?{source_run_id:authored.source_run_id}:{})}),S.selected,S.workspace.id);if(token!==scope()||seq!==statementAnchorSeq)return;if(signature!==JSON.stringify(statementFormValue()))throw Error('You changed the statement while it was loading. Choose Review again.');const a=candidate.anchor;if(a.job_version!==S.pip.current_version||a.lifecycle_revision!==S.pip.lifecycle_revision||(a.source_reference?.run_id??undefined)!==authored.source_run_id)throw Error('The Pip or the linked audit changed. Refresh and try again.');
  const request={type:'record_pip_statement',pip_id:S.selected,...authored,expected_anchor_digest:candidate.digest},body=JSON.stringify(request);if(statementRetry?.body!==body)statementRetry={body,key:window.crypto.randomUUID()};request.request_key=statementRetry.key;
  openReview({title:authored.kind==='fact'?'Add this claim?':'Add this preference?',description:PIP_STATEMENT_NOTICE,body:`<h3>${esc(authored.title)}</h3><p class="goal">${esc(authored.statement)}</p><p class="goal">Why: ${esc(authored.reason)}</p><p class="muted">${authored.expires_at?`Expires ${esc(date(authored.expires_at))}`:'Doesn’t expire'}</p>${statementAnchorMarkup(a,candidate.digest)}<p class="muted">DGC checks again that the Pip and its context haven’t changed before saving. If they have, review it again.</p>`,confirm:'Add',statementAnchor:a,request});
 }catch(error){if(token===scope()&&seq===statementAnchorSeq)setError(error);}finally{if(token===scope()&&seq===statementAnchorSeq){statementInspecting=false;render();}}
}
function revokeStatementReview(id){
 if(S.apiVersion<19||!usable()||S.busy)return;const e=statementRows.find(e=>e.memory.id===id);if(!e||e.memory.status!=='active')return;draft.findingReviewReason='';openReview({title:'Remove this?',description:'Work that starts from now on won’t see it. Runs that already started keep what they had. Nothing else changes.',body:statementRecordMarkup(e.memory,e.effective_status,e.asOf,true),confirm:'Remove',reasonRequired:true,autoReason:'Removed in the Pips view.',statementMemory:e.memory,request:{type:'revoke_pip_statement',pip_id:S.selected,memory_id:id,expected_revision:0}});
}

function notificationsMarkup(){
 if(S.apiVersion<13)return '<section class="section"><h2>Notifications</h2><p class="muted">Update DGC to see notifications here.</p></section>';
 return `<section class="section" aria-label="Workspace notifications"><div class="section-head"><h2>Notifications</h2>${button('refresh-notifications',notificationLoading?'Loading…':'Refresh',notificationLoading||!usable())}</div><p class="muted">${notifications?`${notifications.unread_count} unread.`:'Not loaded yet.'} Marking one read doesn’t approve or start anything.</p>${notificationError?errorMarkup(notificationError):''}${notifications?.sync_pending?'<p class="notice">Still catching up. Refresh to see more.</p>':''}${notifications?.history_may_be_incomplete?'<p class="muted">Some older notifications may be missing.</p>':''}${notificationItems.map(n=>`<article class="entry"><span class="badge">${n.revision?'Read':'Unread'}</span><h3>${esc(notificationWords(n))}</h3>${n.pip_id?`<p class="muted">${esc(S.jobs.find(p=>p.id===n.pip_id)?.name||'Another Pip')}</p>`:''}<p class="muted">${esc(date(n.occurred_at))}</p><div class="actions">${n.source_status!=='unavailable'?`<button type="button" data-open-notification="${esc(n.id)}"${!usable()?' disabled':''}>${n.source_kind==='run'?'View run':'Open saved review'}</button>`:'<span class="muted">What this was about is gone.</span>'}${!n.revision?`<button type="button" data-read-notification="${esc(n.id)}"${notificationMark||notificationLoading||!usable()?' disabled':''}>${notificationMark===n.id?'Marking…':'Mark read'}</button>`:''}</div></article>`).join('')}${notifications&&!notificationItems.length?'<p class="muted">No notifications.</p>':''}${notifications?.has_more&&notificationItems.length<100?button('more-notifications','Older notifications',notificationLoading||!usable()):''}${notifications?.has_more&&notificationItems.length>=100?'<p class="muted">Showing 100. Refresh to go back to the latest.</p>':''}<p class="muted">DGC keeps the latest 500. Something unread may already be handled.</p></section>`;
}
async function loadNotifications(more=false){
 if(S.apiVersion<13||!usable()||!S.workspace||notificationLoading||notificationMark)return;const token=scope(),sequence=++notificationSeq,before=more?notifications?.next_before_seq:null;notificationLoading=true;notificationError='';render();
 try{const page=notificationsPage(await send('list_pip_notifications',{workspace_id:S.workspace.id,limit:20,...(before?{before_seq:before}:{})}),S.workspace.id);if(token!==scope()||sequence!==notificationSeq)return;if(more&&(page.notifications.some(n=>n.seq>=before||notificationItems.some(old=>old.id===n.id))))throw Error('Older notifications didn’t load. Refresh to try again.');notificationItems=more?[...notificationItems,...page.notifications]:page.notifications;notifications=page;}
 catch(error){if(token===scope()&&sequence===notificationSeq)notificationError=errorText(error);}
 finally{if(token===scope()&&sequence===notificationSeq){notificationLoading=false;render();}}
}
async function markNotification(id){
 const n=notificationItems.find(n=>n.id===id);if(!n||n.revision||S.apiVersion<13||!usable()||notificationMark||notificationLoading)return;const token=scope();notificationMark=id;notificationError='';render();
 try{const result=await send('mark_pip_notification_read',{workspace_id:S.workspace.id,notification_id:n.id,expected_revision:n.revision});if(token!==scope())return;const next=pipNotification(result.notification,S.workspace.id);if(next.id!==n.id||next.seq!==n.seq||next.revision!==1||next.source_kind!==n.source_kind||JSON.stringify(next.reference)!==JSON.stringify(n.reference)||typeof result.replayed!=='boolean')throw Error('That didn’t mark as read. Refresh to try again.');notificationItems=notificationItems.map(old=>old.id===id?next:old);if(notifications)notifications={...notifications,unread_count:Math.max(0,notifications.unread_count-1)};}
 catch(error){if(token===scope())notificationError=errorText(error);}
 finally{if(token===scope()){notificationMark='';render();}}
}
async function openNotification(id){const n=notificationItems.find(n=>n.id===id);if(!n||n.source_status==='unavailable'||!usable())return;try{await navigateFromHost(notificationNavigation(n));}catch(error){setError(error);}}

function resetCommandReceipts(){commandSeq++;commandDetailSeq++;commandReceipts=[];commandCursor=null;commandMore=false;commandTotal=0;commandLoaded=false;commandLoading=false;commandError='';commandSession='';}
function commandObservationMarkup(label,v){return `<h3>${esc(label)}</h3>${v?.status==='observed'?`<dl class="meta"><dt>Files fingerprint</dt><dd class="mono">${esc(v.sha256)}</dd><dt>Files read</dt><dd>${v.files} files · ${v.bytes} bytes</dd><dt>Skipped</dt><dd>${v.excluded_entries} files · ${v.excluded_directories} folders</dd></dl>`:`<p class="muted">${v?'Not available: '+esc(v.reason.replaceAll('_',' ')):'Not recorded.'}</p>`}`;}
function commandContextSummary(entry){const s=commandOutcomeSummary(entry);return `<p class="muted">${esc(s.qualifier)}</p><dl class="meta command-outcome-summary"><dt>Result</dt><dd>${esc(s.outcome)}</dd><dt>Output</dt><dd>${esc(s.output)}</dd><dt>Source</dt><dd>${esc(s.source)}</dd></dl>`;}
function commandContextDetails(entry){const p=entry.provenance;return `<details><summary>Saved record</summary><div class="goal">${esc(entry.content)}</div><pre>${esc(p.command.preview)}</pre>${p.command.truncated?'<p class="muted">Only the start of the command is shown.</p>':''}${p.command.redacted?'<p class="muted">Secrets in this command are hidden.</p>':''}<dl class="meta"><dt>Attempt</dt><dd class="mono">${esc(p.attempt_id)}</dd><dt>Session</dt><dd class="mono">${esc(p.session_id)} · version ${p.session_revision_at_attempt}</dd><dt>Attempt SHA-256</dt><dd class="mono">${esc(p.attempt_digest)}</dd><dt>Result SHA-256</dt><dd class="mono">${esc(p.final_digest)}</dd><dt>Reviewed view SHA-256</dt><dd class="mono">${esc(p.view_digest)}</dd><dt>Command SHA-256</dt><dd class="mono">${esc(p.command.sha256)}</dd><dt>Output SHA-256</dt><dd class="mono">${esc(p.facts.output_sha256)}</dd></dl>${commandObservationMarkup('Files before',p.source_before)}${commandObservationMarkup('Files after',p.source_after)}</details>`;}
function commandReceiptsMarkup(){
 if(S.apiVersion<17)return '';
 return `<details class="section" data-details="command-outcomes"><summary>Check command results</summary><p class="muted">Each time a DGC session on this computer ran its check command (the verify command in your settings), the result was saved here. Looking at one, or adding it to context, never runs anything. Exit 0 doesn’t prove tests ran or passed.</p><label for="commandReceiptSession">Session</label><select id="commandReceiptSession"><option value="">All sessions</option>${outcomeSessions.map(r=>`<option value="${esc(r.session_id)}"${r.session_id===commandSession?' selected':''}>${esc(r.session_id)}</option>`).join('')}${commandSession&&!outcomeSessions.some(r=>r.session_id===commandSession)?`<option selected value="${esc(commandSession)}">${esc(commandSession)}</option>`:''}</select><div class="actions">${button('load-command-receipts',commandLoading?'Loading…':commandLoaded?'Refresh':'Show recent results',!usable()||commandLoading)}${!outcomeSessionsLoaded?button('load-outcome-sessions','Load sessions',!usable()||outcomeSessionsLoading):''}${outcomeSessionsMore&&outcomeSessions.length<100?button('more-outcome-sessions','More sessions',!usable()||outcomeSessionsLoading):''}</div>${errorMarkup(commandError)}${commandReceipts.map(r=>`<article class="entry"><span class="badge">${esc(outcomeWords(r.state))}${r.exit_code!==null?' · exit '+r.exit_code:''}</span><pre>${esc(r.command_preview||'(empty command)')}</pre>${r.command_truncated?'<small>Only the start is shown; open it to see the whole command.</small>':''}<p class="muted">${esc(date(r.created_at))} · Session ${esc(r.session_id)}${r.recording?' · In context: '+esc(r.recording.status==='active'?'yes':'archived'):''}${r.redacted?' · Secrets hidden':''}</p><button type="button" data-command-receipt="${esc(r.id)}"${S.busy||!usable()?' disabled':''}>Open…</button></article>`).join('')}${commandLoaded&&!commandReceipts.length?'<p class="muted">No check command results here yet. Other commands a session runs aren’t saved this way.</p>':''}${commandLoaded?`<p class="muted">Showing ${commandReceipts.length} of ${commandTotal}. DGC keeps up to 10,000 and never deletes them on its own.</p>`:''}${commandMore&&commandReceipts.length<100?button('more-command-receipts','Older results',!usable()||commandLoading):''}${commandMore&&commandReceipts.length>=100?'<p class="notice">Showing 100. Choose a session to see older ones.</p>':''}</details>`;
}
async function loadCommandReceipts(more=false){
 if(S.apiVersion<17||!usable()||!S.workspace||commandLoading||more&&(!commandMore||commandReceipts.length>=100))return;
 const token=scope(),sequence=++commandSeq,session=commandSession||null,before=more?commandCursor:null;commandLoading=true;commandError='';render();
 try{const page=commandReceiptsPage(await send('list_workspace_execution_receipts',{workspace_id:S.workspace.id,limit:20,...(session?{session_id:session}:{}),...(before?{before_id:before}:{})}),S.workspace.id,session);if(token!==scope()||sequence!==commandSeq)return;if(more&&page.receipts.some(r=>commandReceipts.some(old=>old.id===r.id)))throw Error('Older results didn’t load. Refresh to try again.');commandReceipts=more?[...commandReceipts,...page.receipts]:page.receipts;commandCursor=page.next_before_id;commandMore=page.has_more;commandTotal=page.total_in_scope;commandLoaded=true;}
 catch(error){if(token===scope()&&sequence===commandSeq)commandError=errorText(error);}
 finally{if(token===scope()&&sequence===commandSeq){commandLoading=false;render();}}
}
async function openCommandReceipt(id){
 if(S.apiVersion<17||!usable()||S.busy||!S.workspace)return;const token=scope(),sequence=++commandDetailSeq;
 try{const answer=await send('get_workspace_execution_receipt',{workspace_id:S.workspace.id,attempt_id:id});if(token!==scope()||sequence!==commandDetailSeq)return;if(answer.workspace_id!==S.workspace.id)throw Error('That result belongs to another project.');const r=commandReceipt(answer.receipt,S.workspace.id,id),f=r.facts,blocked=!r.can_record||!S.context;
 openReview({title:blocked?'Check command result':'Add this result to context?',readOnly:blocked,blocked,commandOutcome:true,description:'What happened when a session ran its check command. Exit 0 doesn’t prove tests ran or passed. Adding it gives no permission and runs nothing.',body:`<h3>Command${r.command.redacted?' · secrets hidden':''}</h3><pre>${esc(r.command.text)}</pre><dl class="meta"><dt>Result</dt><dd>${esc(outcomeWords(r.state))}</dd><dt>Exit code</dt><dd>${f?.exit_code??'Not recorded'}</dd>${f?`<dt>Took</dt><dd>${f.duration_ms} ms</dd><dt>Started</dt><dd>${esc(f.started_at?date(f.started_at):'Didn’t start')}</dd><dt>Ended</dt><dd>${esc(date(f.ended_at))}</dd>`:''}</dl>${!f?'<p class="notice">No result was saved for this command, so it can’t be added: it may not have started, or it never finished.</p>':`<h3>Output${r.output_preview.redacted?' · secrets hidden':''}</h3><pre>${esc(r.output_preview.text||'No output saved.')}</pre><p class="muted">${f.output_bytes} bytes of output; ${f.omitted_bytes} not shown here. Hiding secrets can change the length.</p>${!f.output_complete?'<p class="notice">Some output wasn’t captured, and how much is unknown.</p>':''}<p class="muted">${r.source_comparison==='unchanged_observation'?'The project files looked the same before and after.':r.source_comparison==='changed_observation'?'The project files changed while it ran.':'Couldn’t compare the files before and after.'} This compares two quick looks; it can’t rule out changes in between, or tell exactly which files the command used.</p>`}${r.recording?`<p class="notice">${r.recording.status==='active'?'Already in context. To add it again, archive that record first.':'It was in context before and was archived.'}</p>`:''}<details><summary>Technical details</summary><dl class="meta"><dt>Attempt</dt><dd class="mono">${esc(r.id)}</dd><dt>Session</dt><dd class="mono">${esc(r.session_id)} · revision ${r.session_revision_at_attempt}</dd><dt>Attempt SHA-256</dt><dd class="mono">${esc(r.attempt_digest)}</dd><dt>Result SHA-256</dt><dd class="mono">${esc(r.final_digest??'None')}</dd><dt>Reviewed view SHA-256</dt><dd class="mono">${esc(r.view_digest)}</dd><dt>Command SHA-256</dt><dd class="mono">${esc(r.command.sha256)}</dd>${f?`<dt>Output SHA-256</dt><dd class="mono">${esc(f.output_sha256)}</dd>`:''}${r.recording?`<dt>Context record</dt><dd class="mono">${esc(r.recording.id)}</dd>`:''}</dl>${commandObservationMarkup('Files before',r.source_before)}${commandObservationMarkup('Files after',r.source_after)}</details><p class="muted">Context keeps the exit code, timing, the file check and the start of the command, not the output. Things may be different now.</p>`,confirm:'Add to context',request:{type:'record_workspace_execution_context',workspace_id:S.workspace.id,attempt_id:r.id,expected_attempt_digest:r.attempt_digest,expected_final_digest:r.final_digest,expected_view_digest:r.view_digest,expected_context_revision:S.context?.revision}});
 }catch(error){if(token===scope()&&sequence===commandDetailSeq)setError(error);}
}
function contextMarkup() {
  return `<section class="section"><h2>Workspace context</h2><p class="muted">Notes every Pip in this project sees in its future runs. Runs that already started keep the context they had.</p>${S.context?contextEntries(S.context.entries,true):'<p role="status">Context didn’t load. Refresh to try again.</p>'}</section>${commandReceiptsMarkup()}<form id="context-form" class="form context-form"><h2>Add to context</h2><p class="muted">Up to 32 notes, about 16,000 characters in all. Nothing is shortened for you.</p><label for="contextKind">Kind</label><select id="contextKind" data-draft="contextKind">${[['decision','Decision'],['milestone','Milestone'],['command','Command'],['risk','Risk'],['exception','Exception']].map(([k,label])=>`<option value="${k}"${draft.contextKind===k?' selected':''}>${label}</option>`).join('')}</select>${field('contextTitle','Title')}${field('contextContent','Note',true)}<p class="muted">A command here is only a note: it doesn’t let any Pip run it. To change a note, archive it and add a new one.</p><button type="submit"${S.busy||!usable()||!S.context?' disabled':''}>Review…</button></form>${outcomesMarkup()}`;
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
 if(S.apiVersion>=23&&!S.overview&&!S.create&&S.tab==='chat')return setupRows.length||setupError?`<div class="chat-setup-banner">${button('chat-review-setups',setupError?'Check new Pips':`${setupRows.length} new ${setupRows.length===1?'Pip':'Pips'} waiting for you`)}</div>`:'';
 if(S.apiVersion<23||!setupRows.length&&!setupError&&(S.create||S.selected&&!S.overview))return '';
 return `<section class="setup-inbox" aria-label="Pip setup reviews"><details data-details="setup-inbox"${setupError?' open':''}><summary class="setup-inbox-toggle">${setupRows.length?`${setupRows.length} new ${setupRows.length===1?'Pip':'Pips'} waiting for you`:'Set up a Pip with DGC'}<span>Review</span></summary><div class="section-head"><h2>New Pips${setupRows.length?' · '+setupRows.length:''}</h2>${button('refresh-setups',setupLoading?'Checking…':'Check again',setupLoading||S.busy||!usable())}</div>${errorMarkup(setupError)}${setupRows.map(s=>`<article class="setup-card">${avatar('waiting_approval',S.types.find(t=>t.id===s.pip_type),`setup-${s.id}`)}<div class="setup-card-copy"><span class="badge">Waiting for you</span><h3>${esc(s.name)}</h3><p class="goal">${esc(s.goal)}</p><p class="muted">${esc(s.source_policy==='personal'?'Personal · across your projects':s.project_root)} · ${esc((s.event_trigger?`After each new commit to ${s.source_ref}`:scheduleLabel(s.schedule)))}${s.run_now?' · also runs once now':''}</p></div><div class="actions"><button type="button" data-setup="${esc(s.id)}"${S.busy||!usable()?' disabled':''}>Review…</button><button type="button" data-reject-setup="${esc(s.id)}"${S.busy||!usable()?' disabled':''}>Reject</button></div></article>`).join('')}${setupRows.length>=5?'<p class="muted">Showing 5. Answer one to see more.</p>':''}${!setupRows.length&&!setupError?'<p class="muted">Ask the DGC chat for a new Pip. It appears above the chat box for you to create.</p>':''}</details></section>`;
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
 try{const answer=await send('get_pip_setup',{setup_id:id});if(token!==scope()||sequence!==setupDetailSeq)return;const s=pipSetup(answer.setup,S.workspace.id,id);if(s.status!=='pending'||s.digest!==listed.digest)throw Error('This was changed or answered somewhere else. Check again.');
 const type=S.types.find(t=>t.id===s.pip_type),body=`<dl class="meta setup-summary">${s.source_policy==='personal'?'':`<dt>Project</dt><dd>${esc(s.project_root)}</dd>`}<dt>Pip</dt><dd>${esc(s.name)} · ${esc(type?.name||s.pip_type)}${s.pip_id?' · changes this Pip':' · a new Pip'}</dd><dt>What it does</dt><dd class="goal">${esc(s.goal)}</dd>${s.source_policy==='personal'?'':`<dt>Code</dt><dd>${'Committed code on '+esc(s.source_ref)}</dd>`}<dt>${s.event_trigger?'Runs':'Schedule'}</dt><dd>${s.event_trigger?esc(`After each new commit to ${s.source_ref}, at most every ${s.event_trigger.minimum_minutes} minutes`):esc(scheduleLabel(s.schedule))}</dd><dt>Next scheduled run</dt><dd>${s.next_run_at?esc(date(s.next_run_at)):'When you ask'}</dd><dt>Also run once now</dt><dd>${s.run_now?'Yes, once you accept':'No'}</dd><dt>What it can do</dt><dd>${s.pip_type==='pulse'||s.source_policy==='personal'?esc(s.scope_notice):'Reads the code only. It can’t run commands or tests, check the running app, or change files.'}</dd></dl>${s.app_plan?`<h3>Before each task it reads</h3>${readList(s.app_plan)}`:''}${s.web_plan?`<h3>Web pages it reads</h3><ul class="web-reads">${s.web_plan.reads.map(r=>`<li>${esc(webReadLabel(r))}</li>`).join('')}</ul><p class="muted">DGC reads exactly these before each run. It can’t open other pages.</p>`:''}${s.verification_plan?pulsePlanReview(s.verification_plan):''}${s.live_plan?liveCommandsReview(s.live_plan):''}${s.run_now_policy?`<p class="notice">${esc(s.run_now_policy)}</p>`:''}${s.pip_type==='pulse'||s.source_policy==='personal'?'':`<p class="muted">${esc(s.scope_notice)}</p>`}<p class="notice">${esc(s.runner_notice)}</p><p class="muted">${esc(s.reason)}</p><p class="muted">This offer expires ${esc(date(s.expires_at))}. To change anything, ask DGC in the chat.</p>`;
 openReview({setup:JSON.parse(JSON.stringify(s)),title:reject?'Reject this setup?':s.pip_id?`Change ${s.name}?`:`Create ${s.name}?`,description:reject?'Nothing is created or changed.':'Check it does what you asked.',body,confirm:reject?'Reject setup':s.pip_id?(s.run_now?'Save and run once':'Save changes'):s.run_now?'Create and run once':'Create Pip',expiresAt:s.expires_at,request:{type:reject?'reject_pip_setup':'accept_pip_setup',setup_id:s.id,expected_digest:s.digest}});
 }catch(error){if(token===scope()&&sequence===setupDetailSeq)setError(error);}
}
async function resolveSetup(review){
 if(S.busy||review!==S.review||review.scope!==scope()||!usable())return;
 if(reviewBlocked(review)){review.error='This expired. Ask DGC again.';renderReview();return;}
 const token=scope(),workspace=S.workspace.id;S.busy=true;renderReview();
 try{const result=await send(review.request.type,{setup_id:review.request.setup_id,expected_digest:review.request.expected_digest});if(token!==scope()||!usable())return;const accepted=review.request.type==='accept_pip_setup',s=pipSetupResolution(result.setup,review.setup,accepted);
 closeReview();setupRows=setupRows.filter(row=>row.id!==s.id);S.busy=false;
 if(accepted){const selecting=select(s.receipt.pip_id),selectedScope=scope();await selecting;if(selectedScope!==scope()||!usable()||S.workspace?.id!==workspace)return;S.notice=s.source_policy==='personal'?(s.receipt.run_id?`${s.name} is on and starting its first task.`:`${s.name} is on. It works ${s.next_run_at?'on its schedule and ':''}when you ask.`):s.receipt.run_id?`${s.name} is on and starting its first run. ${s.pip_type==='pulse'?'Check its results before you count it as passing.':s.work_kind==='documentation_draft'?'Its first draft is on the way.':'It reviews the code; it doesn’t test the running app.'}`:s.next_run_at?`${s.name} is on. Its first run is ${date(s.next_run_at)}.`:`${s.name} is on. It runs when you ask.`;S.notice+=keepRunningTold(result);}else S.notice='Rejected. Nothing was created or changed.';
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
 const all=[['chat','Chat'],['runs',postsShown()?'History':personalPip()?'Results':'Runs'],['job','Settings'],['schedule',pulsePip(S.pip)?'Plan & schedule':'Schedule'],['handoffs','Handoffs'],['revisions','Changes'],...(S.apiVersion>=14?[['memory','Memory']]:[]),['context','Context'],...(S.apiVersion>=13?[['notifications','Notifications']]:[])]
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
  if(!S.selected) return `<div class="empty">${avatar()}<h2>${S.jobs.length?'Choose a conversation':'Create your first Pip'}</h2><p class="muted">${S.jobs.length?'Select a Pip from your list to continue its saved conversation, or create another Pip.':S.apiVersion>=23?'Tell DGC what you want looked after. You check the project, schedule and what it may do on one card before anything starts.':'Choose a character and a job for the committed code in this project. You approve anything that changes files or runs commands separately.'}</p>${button('create-first',S.apiVersion>=23?'Describe a job':'Choose a Pip',!usable()||!S.types.length,'primary')}</div>`;
  if(!S.pip) return '<p role="status">Loading Pip…</p>';
  const p=S.pip, pose=presentation(p,S.runs,usable(),S.runner),type=pipType(p,S.types),reviews=pendingReviews(p);
  return `<div class="hero">${pipAvatar(p,pose.state,`detail-${p.id}`,type)}<div class="copy"><h2>${esc(p.name)}</h2><p class="type-role">${type?`${esc(type.name)} · ${personalPip(p)?(p.pip_type==='core'?'Your Primary Pip, in the main chat’s character':'Personal helper'):livePip(p)&&S.apiVersion>=60?'Live data':esc(type.role)}`:'Unsupported Pip type'}</p><p class="muted">${lastRunLink(p,pose.label)} · ${executionPip(p)&&!pulsePip(p)?'runs on approved handoffs':esc(p.event_trigger?'runs on events':p.schedule?scheduleLabel(p.schedule):'runs when you ask')}</p>${reviews?`<span class="review-count">${reviews} waiting for you</span>`:''}</div></div>${archived()?'<p class="notice">Archived. Its chat and results are kept. Restore it in Settings to use it again.</p>':''}${!type?'<p class="notice error">This editor doesn’t know this kind of Pip. You can still read its reports; update the DGC extension to use it.</p>':''}${S.tab==='chat'?'':waitingMarkup()}${S.tab==='chat'?chatMarkup():S.tab==='job'?jobSettingsMarkup():S.tab==='revisions'?revisionsMarkup():S.tab==='schedule'?scheduleMarkup():runsMarkup()}`;
}
// ---------------------------------------------------------------- Simple Pips (API 43)
// Personal Pips the way people meet them: Core is your Primary Pip, a new Pip is a character
// and a name, and each Pip is a chat that sets itself up. The detailed sections (results,
// settings, memory) stay one tap away in the chat's menu. Project Pips keep the full view.
const SIMPLE_CHARACTERS=['core','scout','lens','patch','rook','pulse','lock','quill'];
function simpleMode(){return S.apiVersion>=43&&!remoteHost&&S.workspace?.kind==='personal';}
// Personal | Project (the founder, 2026-10-21): two tabs, as the Sessions home has Chat | Work, where a dropdown listed
// every project DGC knows. Project is this window's folder and nothing else: another project's Pips are for that
// project's DGC to look after ("the user might ask this project's DGC to fix another project's Pips"). No folder
// open, the Project tab says so in one line. A remote view, and a CLI with no Personal Pips, have no tabs, as before.
function personalSpace(){return S.workspaces.find(w=>w?.kind==='personal')||null;}
function projectSpace(){return S.folderOpen&&S.currentWorkspaceId?S.workspaces.find(w=>w?.id===S.currentWorkspaceId&&w.kind!=='personal')||null:null;}
function scopeTabs(){return !remoteHost&&!!personalSpace();}
function scopeTab(){return S.projectEmpty||S.workspace?.kind!=='personal'?'project':'personal';}
// The workspaces this view may open: with tabs, Personal and this folder's project; without, every one, as before.
function openableSpaces(){return scopeTabs()?[personalSpace(),projectSpace()].filter(Boolean):S.workspaces;}
function scopeTabsMarkup(){
 if(!scopeTabs())return '';
 const chosen=scopeTab(),project=projectSpace();
 const tab=(key,label,title)=>`<button type="button" role="tab" id="pips-tab-${key}" class="pips-tab" data-pips-tab="${key}" aria-controls="pips-tabpanel" aria-selected="${chosen===key}"${chosen===key?'':' tabindex="-1"'} title="${esc(title)}">${label}</button>`;
 return `<div class="pips-tabs" role="tablist" aria-label="Your Pips, or this project’s Pips">${tab('personal','Personal','Your Pips: the same in every folder')}${tab('project','Project',project?`${project.name}: this project’s Pips`:'Open a project folder to see its Pips')}</div>`;
}
// What the chosen tab shows is its panel (the list, or a Pip open in it).
function scopePanelAttrs(){return scopeTabs()?` id="pips-tabpanel" role="tabpanel" aria-labelledby="pips-tab-${scopeTab()}"${S.switching?' aria-busy="true"':''}`:'';}
function projectEmptyMarkup(){return `<div class="pips-tab-empty"${scopePanelAttrs()}><p class="muted">Open a project folder to see its Pips.</p></div>`;}
/** Shows another workspace's Pips from the top: what the old dropdown did, and what opening a Pip elsewhere does. */
function enterWorkspace(target){S.epoch++;clearSelection();S.selected='';S.jobs=[];S.context=null;S.create=false;S.overview=true;S.workspace=target;S.projectEmpty=false;S.switching=false;setupRows=[];setupError='';S.error='';rememberView();return refresh(true);}
function chooseScopeTab(name,focus=false){
 if(!scopeTabs()||!usable()||!S.workspace||S.busy)return;
 const target=name==='project'?projectSpace():personalSpace();
 if(!target){
  // No folder open (or none DGC knows): the Project tab is chosen and says so. Personal stays loaded underneath.
  if(!S.projectEmpty){S.projectEmpty=true;clearSelection();S.selected='';S.create=false;S.overview=true;S.error='';rememberView();render();}
 }else if(target.id!==S.workspace.id){
  const loading=enterWorkspace(target),epoch=S.epoch;S.switching=true;render();
  void loading.finally(()=>{if(epoch===S.epoch&&S.switching){S.switching=false;render();}});
 }else if(S.projectEmpty){S.projectEmpty=false;rememberView();render();}
 if(focus)$(`pips-tab-${name}`)?.focus();
}
// "Today 9:47 AM", "Yesterday 6:02 PM", or "Mon 5 Oct, 9:47 AM", like a messaging app.
function chatTime(at){
 const when=new Date(at),now=new Date(),day=d=>new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();
 const time=when.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}),days=Math.round((day(now)-day(when))/86400000);
 return days===0?`Today ${time}`:days===1?`Yesterday ${time}`:`${when.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'})}, ${time}`;
}
function characterType(id){const i=SIMPLE_CHARACTERS.indexOf(id);return S.types.find(t=>t.id===id)||{id,name:id?id[0].toUpperCase()+id.slice(1):'Pip',character_index:i<0?4:i};}
const simpleIcon=name=>`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{back:'<path d="M10 3 5 8l5 5"/>',computer:'<rect x="2" y="2.5" width="12" height="8.5" rx="1.5"/><path d="M6 14h4M8 11v3"/>',more:'<circle cx="3.5" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.5" cy="8" r=".6"/>',share:'<path d="M8 2v8M5 5l3-3 3 3"/><path d="M3 9v4h10V9"/>',gear:'<path d="M2 4h6.5M12 4h2M2 8h2M7.5 8H14M2 12h8.5M14 12h0"/><circle cx="10" cy="4" r="1.6"/><circle cx="5.5" cy="8" r="1.6"/><circle cx="12" cy="12" r="1.6"/>',plus:'<path d="M8 3v10M3 8h10"/>'}[name]}</svg>`;
function meetCoreMarkup(){
 return `<section class="meet-core" aria-label="Meet Core">${avatar('idle',characterType('core'),'meet-core')}<h2>Meet Core</h2><p>Core is your Primary Pip. It is your go-to for everyday tasks, looks after your other Pips, and checks in when it needs your help.</p><p class="muted">Core is also the character of DGC’s main chat: your Primary Pip uses it. It works across your projects, without their files.</p>${button('create-core',S.busy?'Creating…':'Create Core',S.busy||!usable(),'primary pill')}</section>`;
}
// Thousands of Pips (Pips settings sets how many): the home reads the most recent hundred, Core
// first, with Load more and a search over names and titles (list_pips, API 44). The pages already
// read and the Pip that is open stay as each refresh brings the first page again.
S.pipSearch='';S.jobsTotal=null;S.jobsNext=null;let jobsExtra=[],pipSearchTimer=0,jobsMoreBusy=false;
function pipsPaged(){return S.apiVersion>=44&&simpleMode()&&!remoteHost;}
function mergePage(first,value){
 S.jobsTotal=Number.isSafeInteger(value.total)?value.total:first.length;
 if(!jobsExtra.length)S.jobsNext=Number.isSafeInteger(value.next_offset)?value.next_offset:null;
 const seen=new Set(first.map(p=>p.id));return [...first,...jobsExtra.filter(p=>!seen.has(p.id))];
}
// Needs attention (#8): every card your Personal Pips wait on you for, across all of them, on the home.
S.attention=null;let attentionSeq=0,attentionExpanded=false;
async function loadAttention(){
 if(remoteHost||S.apiVersion<44||!simpleMode()||!usable())return;
 const token=scope(),sequence=++attentionSeq;
 try{const page=attentionPage(await send('list_pip_attention',{limit:100}));if(token!==scope()||sequence!==attentionSeq)return;
  const before=JSON.stringify(S.attention);S.attention=page;if(JSON.stringify(page)!==before)render();}
 catch{/* the home still lists every Pip; the next refresh tries again */}
}
function attentionHomeMarkup(){
 const face=i=>i.pip_id?pipAvatar({id:i.pip_id,name:i.pip_name,pip_type:i.pip_type,workspace_id:i.workspace_id},'waiting_approval',`attn-${i.card}`,characterType(i.pip_type)):'<span class="attention-mark" aria-hidden="true">+</span>';
 return attentionMarkup(S.attention,{esc,face,expanded:attentionExpanded,busy:!usable()});
}
// What it remembers (#6): its notes about you, on its page and under the reply that kept them.
S.notes=null;S.notesPip='';S.notesError='';let notesSeq=0,notesBusy=false,noteConfirmAll=false;
async function loadNotes(){
 if(remoteHost||S.apiVersion<44||!personalPip()||!usable())return;
 const token=scope(),pip=S.selected,sequence=++notesSeq;
 try{const notes=notesPage(await send('list_pip_notes',{pip_id:pip,...sharedNotes()}),pip);if(token!==scope()||sequence!==notesSeq||S.selected!==pip)return;
  const before=S.notesPip===pip?JSON.stringify(S.notes):'';S.notes=notes;S.notesPip=pip;S.notesError='';if(JSON.stringify(notes)!==before)render();}
 catch(error){if(token===scope()&&sequence===notesSeq){S.notesError=errorText(error);render();}}
}
// Pips API 46: a Pip's page lists, and forgets, what it kept in your one memory in DGC too (mem_ ids).
function sharedNotes(){return S.apiVersion>=46?{shared:true}:{};}
async function noteCall(type,fields,notice){
 if(notesBusy||!usable()||!personalPip())return;const token=scope(),pip=S.selected;notesBusy=true;S.notesError='';render();
 try{const notes=notesPage(await send(type,{pip_id:pip,...fields,...sharedNotes()}),pip);if(token!==scope()||S.selected!==pip)return;S.notes=notes;S.notesPip=pip;S.notice=notice();}
 catch(error){if(token===scope())S.notesError=errorText(error);}
 finally{notesBusy=false;if(token===scope())render();}
}
function memoryKept(){
 if(S.apiVersion<44||!personalPip()||S.notesPip!==S.selected||!S.notes?.length)return '';
 const last=[...(S.messages||[])].reverse().find(m=>m.role==='assistant'&&m.run_id);
 return last?keptMarkup(S.notes,last.run_id,{esc,busy:notesBusy||!usable()}):'';
}
// Memory that learns (Pips API 57): its own working notes and its daily log, on its page; /learn in its chat.
S.workingNotes=null;S.workingNotesPip='';S.workingNotesError='';S.dailyLog=null;S.dailyLogPip='';S.dailyLogError='';S.learn=null;
let workingNotesSeq=0,workingNotesBusy=false,workingNotesEditing=false,dailyLogSeq=0;
const workingNotesShown=()=>S.apiVersion>=57&&!remoteHost&&personalPip();
const localDay=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
async function loadWorkingNotes(){
 if(!workingNotesShown()||!usable()||workingNotesEditing)return;
 const token=scope(),pip=S.selected,sequence=++workingNotesSeq;
 try{const notes=workingNotesPage(await send('get_pip_working_notes',{pip_id:pip}),pip);if(token!==scope()||sequence!==workingNotesSeq||S.selected!==pip||workingNotesEditing)return;
  const before=S.workingNotesPip===pip?JSON.stringify(S.workingNotes):'';S.workingNotes=notes;S.workingNotesPip=pip;S.workingNotesError='';if(JSON.stringify(notes)!==before)render();}
 catch(error){if(token===scope()&&sequence===workingNotesSeq){S.workingNotesError=errorText(error);render();}}
}
async function saveWorkingNotes(){
 if(workingNotesBusy||!usable()||!S.workingNotes||S.workingNotesPip!==S.selected)return;
 const token=scope(),pip=S.selected;workingNotesBusy=true;S.workingNotesError='';render();
 try{const notes=workingNotesPage(await send('set_pip_working_notes',{pip_id:pip,text:draft.workingNotesText,expected_revision:S.workingNotes.revision}),pip);if(token!==scope()||S.selected!==pip)return;
  S.workingNotes=notes;S.workingNotesPip=pip;workingNotesEditing=false;draft.workingNotesText='';S.notice='Saved. Its next run starts with these notes.';}
 catch(error){if(token===scope())S.workingNotesError=errorText(error);}
 finally{workingNotesBusy=false;if(token===scope())render();}
}
async function loadDailyLog(){
 if(!workingNotesShown()||!usable())return;
 const token=scope(),pip=S.selected,sequence=++dailyLogSeq;
 try{const log=dailyLogPage(await send('list_pip_daily_log',{pip_id:pip,limit:7}),pip);if(token!==scope()||sequence!==dailyLogSeq||S.selected!==pip)return;
  const before=S.dailyLogPip===pip?JSON.stringify(S.dailyLog):'';S.dailyLog=log;S.dailyLogPip=pip;S.dailyLogError='';if(JSON.stringify(log)!==before)render();}
 catch(error){if(token===scope()&&sequence===dailyLogSeq){S.dailyLogError=errorText(error);render();}}
}
function learnCard(){
 if(!S.learn||S.learn.pip!==S.selected)return '';
 return learnCardMarkup({...S.learn,text:S.learn.editing?draft.pipLearnText:S.learn.text},{esc,markdown:renderPipMarkdown,busy:!usable()});
}
async function startLearn(request){
 const pip=S.selected,token=scope();if(!pip||!personalPip())return;
 S.learn={pip,status:'drafting',request:request.request,draft:null,text:'',editing:false,message:''};draft.chatText='';chatDrafts.set(pip,'');render();
 try{const result=await broker.request({type:'learn_skill',pip_id:pip,...(request.request?{request:request.request}:{})},300000);if(token!==scope()||S.learn?.pip!==pip)return;
  if(typeof result?.markdown!=='string'||typeof result?.name!=='string')throw new Error('DGC’s draft was malformed. Try /learn again.');
  S.learn={pip,status:'draft',draft:{name:result.name,description:String(result.description||'')},text:result.markdown,name:result.name,editing:false,message:''};}
 catch(error){if(token===scope()&&S.learn?.pip===pip)S.learn={pip,status:'error',message:errorText(error)};}
 finally{if(token===scope())render();}
}
async function saveLearn(){
 const state=S.learn;if(!state||state.status!=='draft'||state.pip!==S.selected)return;
 const token=scope(),pip=state.pip,markdown_=state.editing?draft.pipLearnText:state.text;state.text=markdown_;state.status='saving';state.message='';render();
 try{const result=await broker.request({type:'save_skill',pip_id:pip,markdown:markdown_});if(token!==scope()||S.learn!==state)return;
  S.learn={pip,status:'saved',name:String(result?.name||state.name)};}
 catch(error){if(token===scope()&&S.learn===state){state.status='draft';state.message=errorText(error);}}
 finally{if(token===scope())render();}
}
// Every new Personal Pip has its own computer (2026-10-09): its page says so and keeps the switch to remove it,
// which lived only on the old Job tab. Its header's computer button opens it.
function computerRowMarkup(p,off){
 if(S.apiVersion<42||remoteHost||!personalPip()||archived())return '';
 return `<section class="pip-page-group" aria-label="Computer"><div class="pip-page-row static"><span class="row-words">${p.computer_plan
  ?`<strong>Its own computer</strong><small>A browser, a Terminal and files, separate from yours. It starts when ${esc(p.name)} needs it.</small></span>${button('remove-computer','Remove…',off,'quiet')}`
  :`<strong>Computer</strong><small>Give ${esc(p.name)} its own computer, so it can look things up and fill in forms for you.</small></span>${button('give-computer','Give it a computer…',off,'quiet')}`}</div></section>`;
}
// How much it asks (Pips API 58): its level, the chosen level's one line, and what its level did by itself.
const levelState={pip:'',value:null,error:'',busy:false,seq:0};
const levelShown=()=>S.apiVersion>=58&&!remoteHost&&personalPip();
async function loadLevel(){
 if(!levelShown()||!usable())return;
 const token=scope(),pip=S.selected,sequence=++levelState.seq;
 try{const value=levelPage(await send('get_pip_level',{pip_id:pip}),pip);if(token!==scope()||sequence!==levelState.seq||S.selected!==pip)return;
  levelState.pip=pip;levelState.value=value;levelState.error='';render();}
 catch(error){if(token===scope()&&sequence===levelState.seq){levelState.error=errorText(error);render();}}
}
async function setLevel(level){
 if(levelState.busy||!usable()||!levelShown())return;const token=scope(),pip=S.selected;levelState.busy=true;levelState.error='';render();
 try{const value=levelPage(await send('set_pip_level',{pip_id:pip,level}),pip);if(token!==scope()||S.selected!==pip)return;levelState.pip=pip;levelState.value=value;S.notice=levelNotice(value);}
 catch(error){if(token===scope())levelState.error=errorText(error);}
 finally{levelState.busy=false;if(token===scope())render();}
}
// How it sees (Pips API 53): whether its model can, and when it can't, your choice; on a Personal Pip's page.
const eyesState={pip:'',value:null,error:'',busy:false,seq:0};
async function loadEyes(){
 if(remoteHost||S.apiVersion<53||!personalPip()||!usable())return;
 const token=scope(),pip=S.selected,sequence=++eyesState.seq;
 try{const value=pipEyes((await send('get_pip_eyes',{pip_id:pip})).eyes,pip);if(token!==scope()||sequence!==eyesState.seq||S.selected!==pip)return;
  eyesState.pip=pip;eyesState.value=value;eyesState.error='';render();}
 catch(error){if(token===scope()&&sequence===eyesState.seq){eyesState.error=errorText(error);render();}}
}
async function setEyes(choice){
 if(eyesState.busy||!usable()||!personalPip())return;const token=scope(),pip=S.selected;eyesState.busy=true;eyesState.error='';render();
 try{const value=pipEyes((await send('set_pip_eyes',{pip_id:pip,choice})).eyes,pip);if(token!==scope()||S.selected!==pip)return;eyesState.pip=pip;eyesState.value=value;S.notice=eyesNotice(choice,value);}
 catch(error){if(token===scope())eyesState.error=errorText(error);}
 finally{eyesState.busy=false;if(token===scope())render();}
}
// Careful mode (#9): its switch and the sites it may visit, on the page of a Pip with a computer.
const carefulState={pip:'',value:null,error:'',busy:false,seq:0};let sitesAll=false;
// Saved logins (Pips API 56): its page lists where each login it may use fills, and the dialog saves one. Nothing the
// user types into the dialog is kept here: the boxes are read once on Save, sent to DGC's sealed store, and emptied.
const loginsState={pip:'',value:null,error:'',busy:false,seq:0,confirm:''};
async function loadLogins(){
 if(S.apiVersion<56||!personalPip()||remoteHost||!S.pip?.computer_plan)return;
 const token=scope(),pip=S.selected,sequence=++loginsState.seq;
 try{const value=pipLogins(await send('list_pip_logins',{pip_id:pip}),pip);if(token!==scope()||sequence!==loginsState.seq||S.selected!==pip)return;
  loginsState.pip=pip;loginsState.value=value;loginsState.error='';render();}
 catch(error){if(token===scope()&&sequence===loginsState.seq){loginsState.error=errorText(error);render();}}
}
async function loginCall(type,fields,notice){
 if(loginsState.busy||!usable()||!personalPip())return;const token=scope(),pip=S.selected;loginsState.busy=true;loginsState.error='';render();
 try{await send(type,fields);if(token!==scope()||S.selected!==pip)return;loginsState.confirm='';S.notice=notice;}
 catch(error){if(token===scope())loginsState.error=errorText(error);}
 finally{loginsState.busy=false;if(token===scope()){render();void loadLogins();}}
}
function pipNames(){return Object.fromEntries((S.jobs||[]).map(j=>[j.id,j.name]));}
function openLoginForm(action=null){
 if(S.apiVersion<56||!usable()||!S.pip)return;
 const s=action?.summary||{};
 openReview({loginForm:true,title:action?`Save a login for ${s.site||s.host}`:'Save a login',
  description:action?`So ${S.pip.name} can sign in to ${s.site||s.host} by itself.`:`So ${S.pip.name} can sign in to a site by itself.`,
  loginAction:action?{id:action.id,digest:action.digest,site:s.site||s.host,shown:s.shown||s.host}:null,request:{}});
}
function renderLoginForm(r){
 const root=$('review-root');
 if(root.querySelector('#login-form')){
  // Already open: never rebuild it (that would empty what the user is typing); say only what changed.
  for(const box of root.querySelectorAll('#login-form input,#login-form button'))if(box.id!=='review-cancel')box.disabled=S.busy;
  const said=root.querySelector('#login-error');if(said){said.textContent=r.error||'';said.hidden=!r.error;}
  return;
 }
 const a=r.loginAction;
 root.innerHTML=`<div class="overlay"><section class="dialog login-dialog" role="dialog" aria-modal="true" aria-labelledby="review-title"><h2 id="review-title" tabindex="-1">${esc(r.title)}</h2><p>${esc(r.description)}</p>${loginFormMarkup({esc,site:a?a.site:'',shown:a?a.shown:'',fixed:!!a,pipName:S.pip?.name||'It',busy:S.busy})}</section></div>`;
 const said=root.querySelector('#login-error');if(said&&r.error){said.textContent=r.error;said.hidden=false;}
 (a?$('loginUser'):$('loginSite'))?.focus({preventScroll:true});
}
async function saveLogin(){
 const r=S.review;if(!r?.loginForm||S.busy||!usable())return;
 const root=$('review-root'),fixed=!!r.loginAction,values=readLoginForm(root,fixed),problem=loginFormProblem(values,fixed);
 if(problem){r.error=problem;renderLoginForm(r);return;}
 const pip=S.pip,token=scope();
 const request={pip_id:pip.id,username:values.username,password:values.password,pips:values.all?'all':'only',
  ...(values.totp?{totp:values.totp}:{}),...(fixed?{action_id:r.loginAction.id,expected_digest:r.loginAction.digest}:{site:values.site})};
 values.password='';values.totp='';
 S.busy=true;r.error='';renderLoginForm(r);
 try{
  const result=await send('save_pip_login',request);
  request.password='';if(request.totp)request.totp='';
  if(token!==scope())return;
  const saved=pipLogin(result?.login);
  clearLoginForm(root);closeReview();
  S.notice=fixed?`Saved. ${pip.name} signs in to ${saved.site} by itself now.`:`Saved. ${pip.name} can sign in to ${saved.site} by itself.`;
  if(fixed){computerState.value=computerState.value?{...computerState.value,actions:computerState.value.actions.filter(x=>x.id!==r.loginAction.id)}:computerState.value;void refreshComputer();void loadMessages();}
 }catch(error){request.password='';if(request.totp)request.totp='';if(token===scope()&&S.review===r){r.error=errorText(error);}}
 finally{if(token===scope()){S.busy=false;if(S.review===r)renderLoginForm(r);render();void loadLogins();}}
}
async function loadCareful(){
 if(remoteHost||S.apiVersion<44||!personalPip()||!S.pip?.computer_plan||!usable())return;
 const token=scope(),pip=S.selected,sequence=++carefulState.seq;
 try{const value=carefulPage(await send('list_pip_sites',{pip_id:pip}),pip);if(token!==scope()||sequence!==carefulState.seq||S.selected!==pip)return;
  carefulState.pip=pip;carefulState.value=value;carefulState.error='';render();}
 catch(error){if(token===scope()&&sequence===carefulState.seq){carefulState.error=errorText(error);render();}}
}
async function carefulCall(type,fields,notice){
 if(carefulState.busy||!usable()||!personalPip())return;const token=scope(),pip=S.selected;carefulState.busy=true;carefulState.error='';render();
 try{const value=carefulPage(await send(type,{pip_id:pip,...fields}),pip);if(token!==scope()||S.selected!==pip)return;carefulState.pip=pip;carefulState.value=value;S.notice=notice;}
 catch(error){if(token===scope())carefulState.error=errorText(error);}
 finally{carefulState.busy=false;if(token===scope())render();}
}
async function navigateAttention(value){
 const {attention:_a,setup,card,cardKind,computer,...rest}=value;
 // Personal Pips live in the Personal workspace; open it first when another is showing.
 if(typeof value.workspace==='string'&&value.workspace!==S.workspace?.id){
  const target=S.workspaces.find(w=>w.id===value.workspace&&w.kind==='personal');
  if(!target)throw Error('Your Personal Pips are unavailable here. Refresh the dashboard.');
  await enterWorkspace(target);
 }
 // The Sessions home's "N more need you · Show all": this home at Needs attention, open in full, your Pips under it.
 if(value.all===true){
  if(S.pipSearch){S.pipSearch='';draft.pipSearch='';jobsExtra=[];S.jobsNext=null;}
  clearSelection();S.selected='';S.create=false;S.overview=true;attentionExpanded=true;rememberView();await refresh(false);await loadAttention();render();
  (document.querySelector('.attention')||document.querySelector('.simple-home'))?.scrollIntoView?.({block:'start'});return;
 }
 if(typeof setup==='string'){
  clearSelection();S.selected='';S.create=false;S.overview=true;rememberView();render();await loadSetups();render();
  const box=document.querySelector('[data-details="setup-inbox"]');if(box){box.open=true;box.scrollIntoView?.({block:'start'});}return;
 }
 await navigateFromHost({...rest,section:rest.section||'chat'});
 if(S.selected!==value.pip)return;
 if(computer){openComputerView();return;}
 if(value.reviewKind==='app_action'&&typeof value.review==='string'){await openMessageReview(value.review);return;}
 if(typeof card==='string')await revealCard(cardSelector(cardKind,card,s=>CSS.escape(s)));
}
// The chat draws its cards as they load (drafts, plugins, apps): look for a few seconds, then show it.
const cardFlash={selector:'',until:0};
async function revealCard(selector){
 const token=scope(),pip=S.selected;
 for(let i=0;i<30;i++){
  const el=document.querySelector(selector);
  if(el){el.scrollIntoView?.({block:'center'});cardFlash.selector=selector;cardFlash.until=Date.now()+2400;el.classList.add('attention-flash');(el.querySelector('button:not([disabled])')||el).focus?.({preventScroll:true});return true;}
  await new Promise(r=>window.setTimeout(r,150));if(token!==scope()||S.selected!==pip)return false;
 }
 return false;
}
async function loadMorePips(){
 if(jobsMoreBusy||S.jobsNext===null||!pipsPaged()||!usable())return;
 const token=scope(),query=S.pipSearch;jobsMoreBusy=true;render();
 try{const v=await send('list_pips',{workspace_id:S.workspace.id,order:'recent',limit:100,offset:S.jobsNext,...(query?{query}:{})});
  if(token!==scope()||query!==S.pipSearch)return;
  if(!Array.isArray(v.pips)||!v.pips.every(p=>p.workspace_id===S.workspace.id))throw new Error('Pips list does not match this workspace.');
  const seen=new Set(S.jobs.map(p=>p.id)),fresh=v.pips.filter(p=>!seen.has(p.id));jobsExtra=[...jobsExtra,...fresh];S.jobs=[...S.jobs,...fresh];
  S.jobsNext=Number.isSafeInteger(v.next_offset)?v.next_offset:null;S.jobsTotal=Number.isSafeInteger(v.total)?v.total:S.jobsTotal;}
 catch(error){if(token===scope())setError(error);}
 finally{jobsMoreBusy=false;if(token===scope())render();}
}
function searchPips(value){
 window.clearTimeout(pipSearchTimer);
 pipSearchTimer=window.setTimeout(()=>{const query=' '.concat(value).trim().replace(/\s+/g,' ').slice(0,120);if(query===S.pipSearch)return;S.pipSearch=query;jobsExtra=[];S.jobsNext=null;void refresh(false);},250);
}
function simpleHomeMarkup(){
 const all=S.jobs.filter(p=>S.showArchived||p.status!=='archived'),live=S.jobs.filter(p=>p.status!=='archived');
 if(!live.length&&!S.jobs.length&&!S.pipSearch)return meetCoreMarkup();   // a search that finds nothing is not an empty home
 return (S.pipSearch?'':attentionHomeMarkup())+simpleHomeList(all,live);
}
function simpleHomeList(all,live){
 const order=[...all.filter(p=>p.pip_type==='core'),...all.filter(p=>p.pip_type!=='core')];
 const row=p=>{const type=pipType(p,S.types)||characterType(p.pip_type),pose=presentation(p,[],usable(),S.runner),waiting=pendingReviews(p)+(S.attention?.byPip[p.id]||0);
  return `<button type="button" class="pip-row" data-job="${esc(p.id)}">${pipAvatar(p,pose.state,`row-${p.id}`,type)}<span class="pip-row-copy"><strong>${esc(p.name)}${p.pip_type==='core'?'<span class="primary-badge" title="Your Primary Pip. It uses Core, the character of DGC’s main chat." aria-label="Primary Pip">★</span>':''}</strong><small>${S.pipSearch&&record(p.match)&&['chat','instructions'].includes(p.match.in)&&typeof p.match.text==='string'?`<span class="pip-match">${p.match.in==='chat'?'In its chat':'In its instructions'}: ${esc(p.match.text.slice(0,200))}</span>`:p.status==='archived'?'Archived':waiting?`${waiting} waiting for you`:esc(pose.label)}</small></span></button>`;};
 return `<section class="simple-home" aria-label="Your Pips"><div class="simple-home-head"><h2>Your Pips</h2><span class="simple-home-actions">${S.apiVersion>=43&&!remoteHost?`<button type="button" id="pips-settings-open" class="topbar-icon" aria-label="Pips settings" title="Pips settings: computers, apps and plugins"${!usable()?' disabled':''}>${simpleIcon('gear')}</button>`:''}${button('simple-new','New Pip',S.busy||!usable(),'primary pill')}</span></div>${pipsPaged()?`<div class="pip-search"><label class="sr-only" for="pip-search">Search your Pips</label><input id="pip-search" type="search" placeholder="Search your Pips" autocomplete="off" value="${esc(draft.pipSearch||'')}" maxlength="120">${S.jobsTotal!==null&&(S.jobsTotal>S.jobs.length||S.pipSearch)?`<small class="pip-search-count">${S.pipSearch?`${S.jobsTotal.toLocaleString('en-US')} found`:`Showing ${S.jobs.length.toLocaleString('en-US')} of ${S.jobsTotal.toLocaleString('en-US')}`}</small>`:''}</div>`:''}${live.some(p=>p.pip_type==='core')||S.pipSearch?'':`<div class="core-offer">${avatar('idle',characterType('core'),'core-offer')}<p><strong>Meet Core</strong><span>Your Primary Pip, for everyday tasks.</span></p>${button('create-core','Create',S.busy||!usable(),'primary pill')}</div>`}<div class="pip-rows">${order.map(row).join('')}</div>${S.pipSearch&&!S.jobs.length?`<p class="muted">No Pip matches “${esc(S.pipSearch)}” in its name, instructions or chat.</p>`:''}${pipsPaged()&&S.jobsNext!==null?button('pips-more',jobsMoreBusy?'Loading…':'Load more',jobsMoreBusy||!usable(),'link'):''}${S.jobs.some(p=>p.status==='archived')?button('show-archived',S.showArchived?'Hide archived':'Show archived',false,'link'):''}</section>`;
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
function pageView(){return S.tab==='job'&&!!S.pip&&personalPip()&&S.apiVersion>=43&&!remoteHost;}
function simpleTabContent(){
 if(pageView())return pipPageMarkup();
 if(S.tab==='memory')return memoriesMarkup()+statementsMarkup();
 if(S.tab==='notifications')return notificationsMarkup();
 if(S.tab==='context')return contextMarkup();
 if(S.tab==='handoffs')return handoffsMarkup();
 return S.tab==='job'?jobSettingsMarkup():S.tab==='revisions'?revisionsMarkup():S.tab==='schedule'?scheduleMarkup():runsMarkup();
}
function simplePipHeader(){
 const p=S.pip,type=pipType(p,S.types)||characterType(p.pip_type),pose=presentation(p,S.runs,usable(),S.runner),onChat=S.tab==='chat';
 const sections=[['chat','Chat'],['runs',historyName('Results')],['job','Settings'],...(S.apiVersion>=14&&!(S.apiVersion>=44&&personalPip())?[['memory','Memory']]:[]),['revisions','Changes'],...(S.apiVersion>=13?[['notifications','Notifications']]:[])].filter(([key])=>key!==S.tab);
 if(S.apiVersion>=43&&!remoteHost&&personalPip()&&screenSetup.pip!==S.selected&&!screenSetup.loading)void loadDesktopStatus();
 const computer=!(S.apiVersion>=42&&personalPip())?'':settingUpComputer()
  ?`<span class="topbar-setup" role="status" title="Getting its computer ready. This happens once."><span class="topbar-spinner" aria-hidden="true"></span>Setting up your Pip…</span>`
  :`<button type="button" id="pip-computer-open" class="topbar-icon" aria-label="Computer" title="${computerState.pip===S.selected&&computerState.value?.granted?'Open its computer':'Its computer'}"${S.busy||!usable()||archived()?' disabled':''}>${simpleIcon('computer')}</button>`;
 if(pageView()){
  // Its page (Grok's bot settings): back, its name, then Share and a small menu.
  const sub=['instructions','character'].includes(S.pipPage),share=S.apiVersion>=41&&['scout','lens','rook','lock','quill'].includes(p.pip_type)&&!archived();
  return `<header class="pip-topbar"><button type="button" id="${sub?'pip-page-back':'simple-to-chat'}" class="topbar-icon" aria-label="${sub?'Back':'Back to the chat'}" title="${sub?'Back':'Back to the chat'}">${simpleIcon('back')}</button><div class="pip-pill">${pipAvatar(p,pose.state,`pill-${p.id}`,type)}<span>${esc(p.name)}</span><small>${sub?(S.pipPage==='character'?'Face':'Instructions'):'Settings'}</small></div><div class="topbar-actions">${share?`<button type="button" class="topbar-icon" data-pip-share aria-label="Share as template" title="Share as template"${S.busy||!usable()?' disabled':''}>${simpleIcon('share')}</button>`:''}<details class="pip-menu" data-details="pip-menu"><summary class="topbar-icon" aria-label="More" title="More">${simpleIcon('more')}</summary><div class="tabs-menu">${pipPageMenu()}</div></details></div></header>`;
 }
 return `<header class="pip-topbar"><button type="button" id="${onChat?'simple-back':'simple-to-chat'}" class="topbar-icon" aria-label="${onChat?'Your Pips':'Back to the chat'}" title="${onChat?'Your Pips':'Back to the chat'}">${simpleIcon('back')}</button><div class="pip-pill">${pipAvatar(p,pose.state,`pill-${p.id}`,type)}<span>${esc(p.name)}</span>${onChat?'':`<small>${esc(sections.length&&{runs:historyName('Results'),job:'Settings',memory:'Memory',revisions:'Versions',notifications:'Notifications',schedule:'Schedule',handoffs:'Handoffs',context:'Context'}[S.tab]||'')}</small>`}</div><div class="topbar-actions">${computer}<details class="pip-menu" data-details="pip-menu"><summary class="topbar-icon" aria-label="More" title="More">${simpleIcon('more')}</summary><div class="tabs-menu">${sections.map(([key,label])=>`<button type="button" data-tab="${key}">${label}</button>`).join('')}</div></details></div></header>`;
}
function simpleMarkup(){
 const bar=`<header class="simple-bar"><h1><span class="pips-wordmark">Pips</span></h1>${runnerMarkup()}</header>${scopeTabsMarkup()}`;
 const notes=`${S.error?`<div class="simple-note">${errorMarkup(S.error)}</div>`:''}${S.notice?`<p class="notice simple-note" role="status">${esc(S.notice)}</p>`:''}`;
 if(pipsSettings.view&&(!S.selected||S.overview)&&!S.create)return `${pipsSettingsMarkup()}${notes}`;
 if(S.projectEmpty&&scopeTabs())return `${bar}${notes}${projectEmptyMarkup()}`;
 if(!S.selected||S.overview||S.create)return `${bar}${notes}${setupRows.length?setupsMarkup():''}<div class="simple-content"${scopePanelAttrs()}>${S.switching?'':simpleHomeMarkup()}</div>`;
 if(!S.pip)return `${bar}<p role="status" class="muted simple-note">Loading…</p>`;
 return `${simplePipHeader()}<div class="simple-content${S.tab==='chat'?' chat':''}" data-view="${esc(S.tab)}">${S.tab==='chat'?chatMarkup():`${notes}${waitingMarkup()}${simpleTabContent()}`}</div>`;
}
function render() {
  if(disposed)return;
  noticeFades();
  const focus=document.activeElement; const focusId=focus?.id; const focusActivity=focus?.dataset?.chatActivity; const focusData=focus?.getAttribute?.('data-run')||focus?.getAttribute?.('data-job')||focus?.getAttribute?.('data-pip-type'); const selection=focus&&typeof focus.selectionStart==='number'?[focus.selectionStart,focus.selectionEnd]:null;
  const oldLog=document.querySelector('.conversation-log'),oldScroll=oldLog?.scrollTop||0,oldHeight=oldLog?.scrollHeight||0,atEnd=!oldLog||oldHeight-oldScroll-oldLog.clientHeight<32,oldFirst=oldLog?.querySelector('[data-message]')?.dataset.message;
  const opened=new Set([...document.querySelectorAll('details[open][data-details]')].map(e=>e.dataset.details));
  const intro=welcome(),chatView=!intro&&!S.create&&!S.overview&&!!S.pip&&S.tab==='chat';
  shell.classList.toggle('sidebar-pinned',S.sidebarPinned);
  shell.classList.toggle('chat-open',!intro&&!S.create&&!S.overview&&!!S.pip&&S.tab==='chat');
  shell.classList.toggle('simple-pips',!intro&&simpleMode());
  const header=(embedded?`<header class="embedded-header${!intro&&scopeTabs()?' scoped':''}"><span class="workspace-name" title="${esc(S.workspace?.name||'Current workspace')}">${esc(S.workspace?.name||'Pips')}</span>${runnerMarkup()}</header>`:`<header><div class="heading"><div>${options.close?button('return-main','Back to DGC',false,'back-control'):''}<h1><span class="pips-wordmark">Pips</span></h1><p class="muted">${esc(S.workspace?.kind==='personal'?'Personal':S.workspace?.name||'Current workspace')}</p></div></div>${runnerMarkup()}</header>`)+(intro?'':scopeTabsMarkup());
  const markup=!intro&&simpleMode()?simpleMarkup():`${header}${S.error&&!chatView?`<div style="padding:0 20px">${errorMarkup(S.error)}</div>`:''}${S.notice&&!chatView?`<p class="notice" role="status">${esc(S.notice)}</p>`:''}${!intro&&S.overview&&!S.create&&!(S.projectEmpty&&scopeTabs())?setupsMarkup():''}${intro?`<div class="content">${intro}</div>`:S.projectEmpty&&scopeTabs()?projectEmptyMarkup():S.switching?`<div class="pips-tab-loading"${scopePanelAttrs()}></div>`:`<div class="layout ${S.overview&&!S.create?'overview':'selected'}"${scopePanelAttrs()}><aside aria-label="Workspace Pips"><div class="aside-heading">${!remoteHost?`<button type="button" id="pin-pips-sidebar" class="sidebar-toggle" aria-label="${S.sidebarPinned?'Collapse Pip sidebar':'Pin Pip sidebar open'}" title="${S.sidebarPinned?'Collapse Pip sidebar':'Pin Pip sidebar open'}" aria-pressed="${S.sidebarPinned}"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 2v12"/></svg></button>`:''}<h2>Your Pips</h2><button type="button" id="new-pip" aria-label="New Pip" title="New Pip"${S.busy||!usable()||!S.types.length?' disabled':''}><span aria-hidden="true" class="new-pip-mark">+</span><span class="new-pip-text">New</span></button></div>${S.overview&&!S.create?`<div class="pips-overview-intro${S.jobs.length?'':' welcome'}"><span class="pips-eyebrow">${S.workspace?.kind==='personal'?'A little help, day to day':'Your project, looked after'}</span><h2>A little team. A clear purpose.</h2><p>Give each Pip a job. Stay in the conversation, and review what comes back.</p></div>`:''}<div class="job-list">${S.jobs.filter(p=>S.showArchived||p.status!=='archived').map(jobMarkup).join('')||`<div class="pips-first-job"><div class="pips-welcome-cast">${S.types.filter(t=>['scout','rook','pulse'].includes(t.id)).map(t=>avatar('idle',t,`welcome-${t.id}`)).join('')}</div><h3>What should your first Pip look after?</h3><p>Describe the job to DGC. You’ll review the scope and schedule before it starts.</p>${button('create-first','Describe a job',!usable()||!S.types.length,'primary')}<small>No Pips yet · Nothing is running for this project</small></div>`}</div>${S.jobs.some(p=>p.status==='archived')?button('show-archived',S.showArchived?'Hide archived Pips':`Show archived Pips (${S.jobs.filter(p=>p.status==='archived').length})`):''}${button('workspace-context','Workspace context',!usable())}${S.apiVersion>=13?button('workspace-notifications','Notifications',!usable()):''}${!embedded&&!remoteHost?`<details><summary>Local controls</summary><p class="muted">Stop all pauses every Pip on this computer and stops what they’re doing. To undo it, resume Pips here, then resume each Pip.</p>${button('disable','Turn off Pips…',S.busy||!usable())}</details>`:''}</aside><div class="content" data-view="${esc(S.tab)}">${!S.create&&(S.selected||['context','notifications'].includes(S.tab))?button('back-pips','Back to Pips',false,'back-control'):''}${S.overview&&!S.create?'':setupsMarkup()}<nav class="tabs" aria-label="Pip sections"${S.create||!S.selected?' hidden':''}>${tabsMarkup()}</nav>${detailMarkup()}</div></div>`}`;
  if(markup===lastMarkup) return;
  lastMarkup=markup;
  const previousAvatars=new Map([...document.querySelectorAll('[data-avatar-key]')].map(node=>[node.dataset.avatarKey,node]));
  avatarObserver?.disconnect();
  $('app').innerHTML=markup;
  reader?.sync();talkBar?.refresh();voiceBar?.refresh();
  const parts=document.querySelector('.pip-ctx-breakdown');if(parts&&S.chatContext?.breakdown&&window.DgcBreakdown)parts.replaceChildren(window.DgcBreakdown.render(S.chatContext.breakdown));
  for(const node of document.querySelectorAll('[data-avatar-key]')){const old=previousAvatars.get(node.dataset.avatarKey);if(old&&old.dataset.character===node.dataset.character&&old.dataset.pose===node.dataset.pose&&(old.dataset.tint||'')===(node.dataset.tint||''))node.replaceWith(old);}
  observeAvatars();fitChatInput();hydrateMessageImages();hydratePluginLogos();
  // A card Needs attention opened stays shown as the chat redraws while its drafts and apps load.
  if(cardFlash.selector&&Date.now()<cardFlash.until)for(const el of document.querySelectorAll(cardFlash.selector))el.classList.add('attention-flash');
  const newLog=document.querySelector('.conversation-log');if(newLog){const first=newLog.querySelector('[data-message]')?.dataset.message;newLog.scrollTop=atEnd?newLog.scrollHeight:first!==oldFirst?oldScroll+newLog.scrollHeight-oldHeight:oldScroll;}
  for(const el of document.querySelectorAll('details[data-details]')) if(opened.has(el.dataset.details)) el.open=true;
  if(focusId && !S.review) { const next=$(focusId);next?.focus({preventScroll:true});if(selection&&next?.setSelectionRange) next.setSelectionRange(...selection); }
  else if(focusActivity&&!S.review)[...document.querySelectorAll('[data-chat-activity]')].find(e=>e.dataset.chatActivity===focusActivity)?.focus({preventScroll:true});
  else if(focusData && !S.review) [...document.querySelectorAll('[data-job],[data-run],[data-pip-type]')].find(e=>e.dataset.job===focusData||e.dataset.run===focusData||e.dataset.pipType===focusData)?.focus({preventScroll:true});
}
async function chooseAppConnection(){
 if(remoteHost||S.apiVersion<29||!personalPip()||!usable())return;
 openReview({title:'Connected apps',description:'Choose which account it reads before each task. Listing accounts doesn’t read anything in them.',readOnly:true,body:'<p class="muted">Loading connections…</p>',request:{type:'list_pip_connections'}});
 const ticket=S.review;
 try{const answer=await send('list_pip_connections');if(S.review!==ticket||ticket.scope!==scope())return;
 if(!Array.isArray(answer.connections)||answer.connections.length>64)throw Error('The connection list is invalid.');
 const supported=answer.connections.filter(c=>c?.enabled===true&&c.pip_read_adapter===true&&typeof c.name==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(c.name));
 ticket.body=supported.length?'<div class="actions">'+supported.map(c=>`<button type="button" data-app-connection="${esc(c.name)}">${esc(c.provider||c.name)} · ${esc(c.name)}</button>`).join('')+'</div>':`<p>No apps connected yet. Ask ${esc(S.pip?.name||'this Pip')} in its chat to connect one.</p>`;renderReview();
 }catch(error){if(S.review===ticket){ticket.error=errorText(error);renderReview();}}
}
async function chooseAppAccount(server){
 if(remoteHost||S.apiVersion<29||!personalPip()||!usable())return;
 openReview({title:'Choose app access',description:'Loading account identities and supported read tools. No app contents are fetched.',readOnly:true,body:'<p class="muted">Checking the existing connection…</p>',request:{type:'list_pip_accounts',server}});
 const ticket=S.review;
 try{const [discovery,inspection]=await Promise.all([send('list_pip_accounts',{server}),send('inspect_pip_connection',{server})]);if(S.review!==ticket||ticket.scope!==scope())return;
 const choices=accountChoices(server,discovery,inspection).filter(c=>S.apiVersion>=39||!extraReadTools.includes(c.tool));
 if(!choices.length){ticket.description='No selectable accounts were returned.';ticket.body='<p>No accounts found. Connect one (Composio → Connect Apps), then refresh. DGC won’t pick an account for you.</p>';renderReview();return;}
 ticket.readOnly=false;ticket.confirm='Prepare review';ticket.appPicker={server,fingerprint:discovery.connection_digest,choices};ticket.description='Choose exactly what it can read. You’ll confirm it next; nothing changes until you do.';
 ticket.body=`<div class="form"><label for="app-account">Account and app</label><select id="app-account"><option value="">Choose an account…</option>${choices.map((c,i)=>`<option value="${i}">${esc(appLabels[c.toolkit])} · ${esc(c.label)} · …${esc(c.id.slice(-6))}</option>`).join('')}</select><p id="app-read-notice" class="muted"></p><label id="app-query-label" for="app-query">Search query (optional)</label><input id="app-query" maxlength="1024" placeholder="For example: is:unread"><label for="app-limit">Maximum items per run</label><input id="app-limit" type="number" min="1" max="20" value="5"><div id="app-calendar-window" hidden>${S.apiVersion>=33?`<label for="app-window-mode">Calendar window</label><select id="app-window-mode"><option value="fixed">Fixed dates</option><option value="calendar_days">Move with each run</option></select><div id="app-relative-window" hidden><label for="app-window-zone">Timezone</label><input id="app-window-zone" value="${esc(defaultZone)}" maxlength="100"><label for="app-window-start">Start day (0 means today)</label><input id="app-window-start" type="number" min="0" max="30" value="0"><label for="app-window-days">Number of calendar days</label><input id="app-window-days" type="number" min="1" max="31" value="1"><p class="muted">From midnight in this timezone on the day this run reads the calendar, through the end of the selected days. A delayed run uses its actual read day. No calendar changes are permitted.</p></div>`:''}<div id="app-fixed-window"><label for="app-start">Calendar start (${esc(defaultZone)})</label><input id="app-start" type="datetime-local"><label for="app-end">Calendar end (${esc(defaultZone)})</label><input id="app-end" type="datetime-local"><p class="muted">This is an exact date range. It will not move forward automatically on scheduled runs.</p></div></div></div><p>What it reads goes to ${esc(modelLabel(S.pip.model_choice))}. This lets it read only.</p>${S.pip.app_plan?'<label for="app-plan-mode">Existing app reads</label><select id="app-plan-mode"><option value="replace">Replace existing reads</option><option value="add">Add to existing reads</option></select><p class="muted">The final review shows both versions. Up to four reads from the same connection.</p>':''}<p id="app-picker-error" role="alert" class="error"></p>`;renderReview();
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
 try{const answer=emailDraftsPage(await send(calendar?'list_pip_calendar_drafts':'list_pip_message_drafts',{pip_id:S.selected,limit:20}),S.selected,S.workspace.id,calendar);if(token!==scope()||sequence!==(calendar?calendarDraftSeq:emailDraftSeq))return;S[calendar?'calendarDrafts':'emailDrafts']=answer.drafts;S[calendar?'calendarDraftError':'emailDraftError']='';render();void loadDraftDetails();}catch(error){if(token===scope()&&sequence===(calendar?calendarDraftSeq:emailDraftSeq)){S[calendar?'calendarDraftError':'emailDraftError']=errorText(error);render();}}
}
function emailDraftCards(){
 if(remoteHost||S.apiVersion<32||!personalPip())return '';
 // An email it wrote is Grok's Allow card: what it would send, and Send / Always allow right here.
 const gmail=connectedLink('gmail'),calendar=connectedLink('googlecalendar'),pipName=S.pip?.name||'This Pip';
 const full=d=>S.apiVersion>=43?draftDetails.get(d.id+':'+d.digest):null,open=d=>d.status==='pending'&&!d.expired&&full(d);
 const allow=(S.emailDrafts||[]).filter(open).map(d=>allowCardMarkup(full(d),{esc,link:gmail,busy:allowBusy===d.id||S.busy||archived(),pipName,edit:cardEdit(d)})).join('')
  +(S.apiVersion>=35?S.calendarDrafts||[]:[]).filter(open).map(d=>calendarCardMarkup(full(d),{esc,link:calendar,busy:allowBusy===d.id||S.busy||archived(),pipName,edit:cardEdit(d)})).join('');
 return allow+[...(S.emailDrafts||[]).filter(d=>!full(d)),...(S.apiVersion>=35?(S.calendarDrafts||[]).filter(d=>!full(d)):[]),...(S.apiVersion>=37?(S.connectorDrafts||[]).filter(d=>!pluginDraft(d)):[])].filter(d=>d.status==='pending'&&!d.expired).map(d=>{const label=d.id.startsWith('conndraft_')?'App action for you to check':d.id.startsWith('caldraft_')?'Calendar event for you to check':'Email for you to check';return `<div class="chat-setup-review" aria-label="${label}"><span class="chat-setup-label">${label} <small>${esc(d.subject)}</small></span><button type="button" data-email-draft="${esc(d.id)}"${S.busy?' disabled':''}>Review</button></div>`;}).join('')+(S.emailDraftError?errorMarkup(S.emailDraftError):'')+(S.calendarDraftError?errorMarkup(S.calendarDraftError):'')+(S.connectorDraftError?errorMarkup(S.connectorDraftError):'');
}
// A Personal Pip's own apps (pip_app_links): the Connect card it asks for with connect_app.
let appLinkSeq=0,appLinkBusy='',appLinkTimer=0,appLinkUntil=0;const appLinkHosts=new Map();
async function loadAppLinks(){
 if(remoteHost||S.apiVersion<43||!personalPip()||!usable())return;
 const token=scope(),sequence=++appLinkSeq,pip=S.selected;
 try{const page=appLinksPage(await send('list_pip_app_links',{pip_id:pip}),pip);if(token!==scope()||sequence!==appLinkSeq||S.selected!==pip)return;
  S.appLinks=page.links;S.composio=page.composio;S.appLinksError='';render();watchAppSignIn();}
 catch(error){if(token===scope()&&sequence===appLinkSeq){S.appLinksError=errorText(error);render();}}
}
function appLinkCards(){
 if(remoteHost||S.apiVersion<43||!personalPip())return '';
 const cards=shownAppLinks(S.appLinks).map(link=>appLinkMarkup(link,{esc,busy:appLinkBusy===link.id||S.busy||archived(),composio:S.composio!==false,host:appLinkHosts.get(link.id)||'',pipName:S.pip?.name||'This Pip'}));
 return cards.join('')+(S.appLinksError?`<p class="app-link-note" role="alert">${esc(S.appLinksError)}</p>`:'');
}
function putAppLink(link){S.appLinks=[link,...(S.appLinks||[]).filter(l=>l.id!==link.id&&l.toolkit!==link.toolkit)];}
// A Personal Pip's plugins (pip_plugins): it asks with use_plugin and you Allow it on its card. What it
// would then do in a plugin is an Allow card here: Allow, Always allow (never for a plugin that can
// move money) or Don't. The same reviewed steps as the connector dialogs, without them.
S.plugins=[];S.pluginsInstalled=[];S.pluginsError='';let pluginSeq=0,pluginBusy='';const pluginDrafts=new Map();
// Your own apps (Pips API 61): registered by your code; a change a Pip proposes in one is this same Allow card.
S.ownApps=[];S.ownAppsError='';let ownAppsSeq=0;
async function loadOwnApps(){
 if(remoteHost||S.apiVersion<61||!usable())return;
 const token=S.epoch,sequence=++ownAppsSeq;
 try{const apps=ownAppsPage(await send('list_apps'));if(token!==S.epoch||sequence!==ownAppsSeq)return;
  S.ownApps=apps;S.ownAppsError='';render();if(apps.length&&personalPip())void loadPluginDrafts();}
 catch(error){if(token===S.epoch&&sequence===ownAppsSeq){S.ownAppsError=errorText(error);render();}}
}
async function acceptOwnAppUpdate(name,digest){
 if(!usable()||pipsSettings.busy)return;
 await pipsSettingsCall('accept_app_update',{name,expected_digest:digest},r=>`${r?.app?.display_name||'Your app'} is up to date: ${r?.app?.summary||''}.`);
 void loadOwnApps();
}
async function loadPlugins(){
 void loadOwnApps();
 if(remoteHost||S.apiVersion<44||!personalPip()||!usable())return;
 const token=scope(),sequence=++pluginSeq,pip=S.selected;
 try{const page=pluginsPage(await send('list_pip_plugins',{pip_id:pip}),pip);if(token!==scope()||sequence!==pluginSeq||S.selected!==pip)return;
  S.plugins=page.plugins;S.pluginsInstalled=page.installed;S.pluginsError='';render();void loadPluginDrafts();}
 catch(error){if(token===scope()&&sequence===pluginSeq){S.pluginsError=errorText(error);render();}}
}
// The draft list carries summaries; a plugin's Allow card shows the whole call, read once per version.
async function loadPluginDrafts(){
 // API 45 on there are no cards to allow: every plugin turned on is every Pip's, so any installed one may have a draft.
 if(S.apiVersion<44||!personalPip()||!usable()||!((S.plugins||[]).some(c=>c.status==='allowed')||S.apiVersion>=45&&(S.pluginsInstalled||[]).length||S.apiVersion>=61&&(S.ownApps||[]).length))return;
 const token=scope(),pip=S.selected;
 for(const d of (S.connectorDrafts||[]).filter(d=>d.status==='pending'&&!d.expired&&!pluginDrafts.has(d.id+':'+d.digest)).slice(0,5)){
  try{const v=connectorDraft((await send('get_pip_connector_draft',{draft_id:d.id})).draft,pip,S.workspace.id);if(token!==scope()||S.selected!==pip)return;
   if(v.id===d.id&&v.digest===d.digest){pluginDrafts.set(d.id+':'+d.digest,v);render();}}
  catch{/* the Review row stays */}
 }
}
// Approvals in your app (Pips API 62): a change your app decided before you did. Its card was shown (so its draft is
// known); once settled, its action says who decided, read once.
const ownAppDecisions=new Map();
function ownAppSettled(){return (S.connectorDrafts||[]).filter(d=>d.status==='prepared'&&!d.expired&&d.action_id&&isOwnApp(pluginDrafts.get(d.id+':'+d.digest)?.payload?.action?.server));}
async function loadOwnAppDecisions(){
 if(remoteHost||S.apiVersion<62||!personalPip()||!usable())return;
 const token=scope(),pip=S.selected;
 for(const d of ownAppSettled().filter(d=>!ownAppDecisions.has(d.action_id)).slice(0,3)){
  try{const a=messageReview((await send('get_pip_app_action',{action_id:d.action_id})).action,pip,S.workspace.id);if(token!==scope()||S.selected!==pip)return;
   if(a.id===d.action_id){ownAppDecisions.set(a.id,a);render();}}
  catch{/* the chat says what happened */}
 }
}
// Shown under the chat until anything newer is in it (a message, or a run's post), so it never sits under a later
// reply as if it were about that one.
function ownAppDecidedCards(){
 if(S.apiVersion<62)return '';
 const latest=Math.max(0,...(S.messages||[]).filter(m=>m.intro!==true).map(m=>Date.parse(m.created_at)||0),
  ...(postsShown()&&S.postsPip===S.selected?S.posts||[]:[]).map(p=>Date.parse(p.posted_at)||0));
 return ownAppSettled().map(d=>{const a=ownAppDecisions.get(d.action_id),decided=a&&ownAppDecision(a);
  return decided&&(Date.parse(a.resolved_at)||0)>latest?ownAppDecisionMarkup(d.id,decided,{esc}):'';}).join('');
}
function pluginDraft(d){const v=S.apiVersion>=44&&pluginDrafts.get(d.id+':'+d.digest),server=v&&v.payload.action.server;
 const plugin=v&&(S.apiVersion>=61&&ownAppForServer(S.ownApps,server,v.payload.action.call.tool)||pluginForServer(S.plugins,server)||S.apiVersion>=45&&installedForServer(S.pluginsInstalled,server));return v&&plugin?{draft:v,plugin}:null;}
function pluginCards(){
 if(remoteHost||S.apiVersion<44||!personalPip())return '';
 const pipName=S.pip?.name||'This Pip',off=archived()||S.busy;
 const actions=(S.connectorDrafts||[]).filter(d=>d.status==='pending'&&!d.expired).map(pluginDraft).filter(Boolean)
  .map(({draft,plugin})=>pluginActionMarkup(draft,plugin,{esc,busy:pluginBusy===draft.id||off,pipName,edit:cardEdit(draft)}));
 actions.push(ownAppDecidedCards());
 const lastReply=Math.max(0,...(S.messages||[]).filter(m=>m.role==='assistant').map(m=>Date.parse(m.created_at)||0));
 const cards=shownPluginCards(S.plugins,Date.now(),lastReply).map(c=>pluginCardMarkup(c,{esc,busy:pluginBusy===c.id||off,pipName}));
 return actions.join('')+cards.join('')+(S.pluginsError?`<p class="app-link-note" role="alert">${esc(S.pluginsError)}</p>`:'');
}
// Borrowing your own signed-in Chrome (pip_borrow, API 59): the card it asks with, Allow once or Not now; while lent,
// "Using your Chrome · site" with Stop; then "Gave your Chrome back". Looked at again every 1.5 s while one is lent.
S.borrows=[];S.borrowsError='';let borrowSeq=0,borrowBusy='',borrowTimer=0;
async function loadBorrows(){
 window.clearTimeout(borrowTimer);
 if(remoteHost||S.apiVersion<59||!personalPip()||!usable())return;
 const token=scope(),sequence=++borrowSeq,pip=S.selected;
 try{const cards=borrowsPage(await send('list_pip_borrows',{pip_id:pip}),pip);if(token!==scope()||sequence!==borrowSeq||S.selected!==pip)return;
  const was=borrowActive(S.borrows);S.borrows=cards;S.borrowsError='';render();
  if(borrowActive(cards)&&!disposed)borrowTimer=window.setTimeout(()=>{if(!disposed&&S.selected===pip)void loadBorrows();},1500);
  else if(was)void loadMessages();}
 catch(error){if(token===scope()&&sequence===borrowSeq){S.borrowsError=errorText(error);render();}}
}
function borrowCards(){
 if(remoteHost||S.apiVersion<59||!personalPip())return '';
 const lastUserAt=Math.max(0,...(S.messages||[]).filter(m=>m.role==='user'&&m.intro!==true).map(m=>Date.parse(m.created_at)||0));
 const pipName=S.pip?.name||'This Pip',off=archived()||S.busy||!usable(),replying=Boolean(S.chatActiveRun);
 return shownBorrows(S.borrows,{lastUserAt}).map(c=>borrowMarkup(c,{esc,busy:borrowBusy===c.id||off,pipName,replying:replying&&c.status==='requested'})).join('')
  +(S.borrowsError?`<p class="app-link-note" role="alert">${esc(S.borrowsError)}</p>`:'');
}
async function borrowAnswer(type,id){
 if(!usable()||!personalPip()||borrowBusy)return;
 const token=scope(),pip=S.selected,pipName=S.pip?.name||'This Pip';borrowBusy=id;render();
 try{const card=borrowResult(await send(type,{pip_id:pip,borrow_id:id}),pip,id);if(token!==scope()||S.selected!==pip)return;
  S.borrows=[card,...(S.borrows||[]).filter(c=>c.id!==id)];
  S.notice=type==='allow_pip_borrow'?`${pipName} can use your Chrome once now. Chrome asks you too: choose Allow there.`
   :type==='stop_pip_borrow'?`${pipName} gave your Chrome back.`:'Not now.';
  void loadMessages();
 }catch(error){if(token===scope())setError(error);}
 finally{if(token===scope()){borrowBusy='';render();if(borrowActive(S.borrows))void loadBorrows();}}
}
async function pluginAnswer(type,id,takeBack=false){
 if(!usable()||!personalPip()||pluginBusy)return;
 const token=scope(),pip=S.selected,pipName=S.pip?.name||'This Pip';pluginBusy=id;render();
 try{const card=pluginResult(await send(type,{pip_id:pip,grant_id:id}),pip,id);if(token!==scope()||S.selected!==pip)return;
  S.plugins=[card,...(S.plugins||[]).filter(c=>c.id!==id&&c.plugin!==card.plugin)];
  S.notice=card.status==='allowed'?`${pipName} can use ${card.name} now.`:takeBack?`${pipName} no longer uses ${card.name}. It stays in DGC.`:'Not now.';
  if(card.status==='allowed'){void loadMessages();void loadPluginDrafts();}
 }catch(error){if(token===scope())setError(error);}
 finally{if(token===scope()){pluginBusy='';render();}}
}
async function pluginRun(id,always=false){
 const d=(S.connectorDrafts||[]).find(x=>x.id===id),found=d&&pluginDraft(d);
 if(!found||found.draft.status!=='pending'||found.draft.expired||!usable()||pluginBusy)return;
 const {draft,plugin}=found,a=draft.payload.action,token=scope(),pip=S.selected,pipName=S.pip?.name||'This Pip',edit=cardEdit(draft);
 let call;
 try{call=connectorCall(edit?{tool:a.call.tool,arguments:editedArguments(a.call.arguments||{},edit.values)}:a.call);}catch(error){cardError(edit,error);return;}
 const changed=edit&&JSON.stringify(call.arguments)!==JSON.stringify(a.call.arguments);
 if(edit)edit.error='';always=always&&!plugin.money;pluginBusy=id;render();
 try{
  const expected={source_run_id:draft.source_run_id,server:a.server,connection_digest:a.connection_digest,schema_digest:a.schema_digest,call};
  const prepared=(await send('prepare_pip_connector_draft',{draft_id:draft.id,expected_digest:draft.digest,call})).action;
  if(token!==scope()||S.selected!==pip)return;
  // Your own app decided it first (Pips API 62): say what it decided; nothing more runs.
  const first=isOwnApp(a.server)&&prepared?.status!=='pending'&&ownAppDecision(messageReview(prepared,pip,S.workspace.id));
  if(first){cardEdits.delete(id);ownAppDecisions.set(prepared.id,prepared);S.notice=ownAppDecisionNotice(first);void loadMessages();return;}
  const action=messageReview(prepared,pip,S.workspace.id,expected);
  const done=await send(always?'always_allow_pip_app_action':'accept_pip_app_action',{action_id:action.id,expected_digest:action.digest});
  if(token!==scope())return;
  cardEdits.delete(id);
  const beat=isOwnApp(a.server)&&ownAppDecision(done?.action);
  if(beat)ownAppDecisions.set(done.action.id,done.action);
  S.notice=beat?ownAppDecisionNotice(beat):done?.action?.status==='succeeded'
   ?`Done: ${a.call.tool} ran in ${plugin.name}${changed?' with your changes':''}.`+(always?` ${pipName} may run it without asking now; take it back on its page.`:'')
   :`${plugin.name} didn’t confirm ${a.call.tool}. Check it there before you try again.`;
  void loadMessages();   // the Pip reads what it answered and carries on
 }catch(error){if(token===scope()){if(edit)cardError(edit,error);else setError(error);}}
 finally{if(token===scope()){pluginBusy='';render();}}
}
function pluginSkip(id){
 const d=(S.connectorDrafts||[]).find(x=>x.id===id);if(!d||S.busy||!usable()||pluginBusy)return;
 void mutate({type:'dismiss_pip_connector_draft',draft_id:d.id,expected_digest:d.digest},r=>{const v=connectorDraft(r.draft,S.selected,S.workspace.id);if(v.id!==d.id||v.status!=='dismissed')throw Error('The dismissal does not match this action.');S.notice='Not run.';void loadEmailDrafts();});
}
// ---- A Personal Pip's page, as on Grok's bots: face, name and title, then Info (Instructions,
// Routines, Notifications, Share as template), Links, Media and Files. And its routines' cards.
S.pipPage='info';S.routines=null;S.routinesError='';
let routineSeq=0,routineEditing='',routineBusy='',routineError='',pageNameDirty=false,lookDirty=false,profileBusy=false;
const shared={pip:'',kind:'',items:null,error:'',loading:false,seq:0,desk:null};
const pipsSettings={view:'',computers:null,computersError:'',apps:null,appsError:'',plugins:null,pluginsError:'',confirmReset:'',seq:0,busy:false};
Object.assign(draft,{pipPageName:'',pipPageTitle:'',pipInstructions:'',lookBody:'',lookColor:''},routineDraft(null,defaultZone));
const tintStyle=document.createElement('style');tintStyle.textContent=tintStyles;document.head.append(tintStyle);
// A Personal Pip's chosen face and colour; any other Pip keeps the face its type gives it.
function pipAvatar(p,state,key,type){const look=profile(p?.profile),own=personalPip(p);return avatar(state,own&&look.body?characterType(look.body):type,key,own?look.color||'':'');}
function sameJson(a,b){const norm=v=>Array.isArray(v)?v.map(norm):record(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,norm(v[k])])):v;return JSON.stringify(norm(a))===JSON.stringify(norm(b));}
async function loadRoutines(){
 if(remoteHost||S.apiVersion<43||!personalPip()||!usable())return;
 const token=scope(),sequence=++routineSeq,pip=S.selected;
 try{const list=routinesPage(await send('list_pip_routines',{pip_id:pip}),pip);if(token!==scope()||sequence!==routineSeq)return;S.routines=list;S.routinesError='';render();}
 catch(error){if(token===scope()&&sequence===routineSeq){S.routinesError=errorText(error);render();}}
}
function routineCards(){
 if(remoteHost||S.apiVersion<43||!personalPip()||!S.routines)return '';
 return shownRoutineCards(S.routines).map(r=>routineCardMarkup(r,{esc,busy:routineBusy===r.id||S.busy||archived()||!usable(),formatDate:date})).join('');
}
async function routineCall(command,args,id,notice){
 if(S.busy||!usable()||routineBusy)return null;const token=scope(),pip=S.selected;routineBusy=id||'form';routineError='';render();
 try{const result=await send(command,{pip_id:pip,...args});if(token!==scope())return null;if(notice)S.notice=notice+keepRunningTold(result);await loadRoutines();return result||{};}
 catch(error){if(token===scope()){routineError=errorText(error);if(!routineEditing)S.error=routineError;}return null;}
 finally{if(token===scope()){routineBusy='';render();}}
}
function editRoutine(id){
 const r=(S.routines||[]).find(x=>x.id===id);if(id!=='new'&&!r)return;
 routineEditing=id;routineError='';Object.assign(draft,routineDraft(id==='new'?null:r,defaultZone));render();$('routineTitle')?.focus();
}
async function saveRoutine(){
 const isNew=routineEditing==='new',current=(S.routines||[]).find(x=>x.id===routineEditing);
 let value;try{value=routineFromDraft(draft.routineKind==='custom'?{...draft,routineKind:'daily'}:draft);}catch(error){routineError=errorText(error);render();return;}
 if(isNew){if(await routineCall('add_pip_routine',value,'form','Routine added. It runs on its own now.'))routineEditing='';render();return;}
 if(!current)return;
 const changes={title:value.title,prompt:value.prompt};if(draft.routineKind!=='custom'&&!sameJson(value.trigger,current.trigger))changes.trigger=value.trigger;
 if(await routineCall('update_pip_routine',{routine_id:current.id,changes},'form','Saved.'))routineEditing='';render();
}
function routinesSectionMarkup(){
 if(S.routinesError&&!S.routines)return errorMarkup(S.routinesError);
 if(!S.routines)return '<p class="muted" role="status">Loading…</p>';
 const links=S.appLinks||[],busy=!!routineBusy||S.busy||!usable();
 const form=routineEditing?routineFormMarkup(draft,{esc,busy,error:routineError,isNew:routineEditing==='new',gmail:links.some(l=>l.status==='connected'&&l.toolkit==='gmail'),calendar:links.some(l=>l.status==='connected'&&l.toolkit==='googlecalendar')}):'';
 return routinesMarkup(S.routines,{esc,busy,editing:routineEditing,form,formatDate:date,pipName:S.pip.name,schedule:S.pip.schedule?scheduleLabel(S.pip.schedule):''})+(S.legacyOpen&&S.pip.schedule?`<div class="routine-legacy-edit">${quickScheduleMarkup()}</div>`:'');
}
function openPipPage(view='info'){
 const p=S.pip;if(!p)return;
 S.pipPage=view;draft.pipPageName=p.name;draft.pipPageTitle=profile(p.profile).title;pageNameDirty=false;lookDirty=false;routineEditing='';routineError='';
 void loadRoutines();void loadAppLinks();void loadPlugins();void loadNotes();void loadCareful();void loadEyes();void loadLevel();void loadLogins();noteConfirmAll=false;sitesAll=false;loginsState.confirm='';
}
function putProfile(pipId,value){
 const p=profile(value);if(S.pip?.id===pipId)S.pip={...S.pip,profile:p};S.jobs=S.jobs.map(j=>j.id===pipId?{...j,profile:p}:j);
}
async function setProfile(changes,notice){
 if(S.busy||!usable()||!S.pip||profileBusy)return false;const pip=S.pip.id,token=scope();profileBusy=true;S.busy=true;S.error='';render();
 try{const result=await send('set_pip_profile',{pip_id:pip,changes});if(token!==scope())return false;
  if(!record(result)||result.pip_id!==pip)throw Error('DGC answered about another Pip. Refresh.');putProfile(pip,result.profile);if(notice)S.notice=notice;return true;}
 catch(error){if(token===scope())S.error=errorText(error);return false;}
 finally{profileBusy=false;if(token===scope()){S.busy=false;render();}}
}
async function saveNameAndTitle(){
 const p=S.pip,name=draft.pipPageName.trim(),title=draft.pipPageTitle.trim();
 if(!name){setError('Give it a name.');return;}
 if(title!==profile(p.profile).title&&!await setProfile({title}))return;
 if(name!==p.name&&!await applyOwnChange({name},d=>d.name===name,'Saved.'))return;
 if(name===p.name)S.notice='Saved.';
 pageNameDirty=false;draft.pipPageName=S.pip?.name||name;draft.pipPageTitle=profile(S.pip?.profile).title;render();
}
async function loadShared(kind){
 if(remoteHost||S.apiVersion<43||!personalPip()||!usable())return;
 const token=scope(),sequence=++shared.seq,pip=S.selected;
 if(shared.pip!==pip||shared.kind!==kind){shared.items=null;shared.desk=null;}
 shared.pip=pip;shared.kind=kind;shared.loading=true;shared.error='';render();
 try{const items=sharedPage(await send('list_pip_shared',{pip_id:pip,kind}),pip,kind);if(token!==scope()||sequence!==shared.seq)return;shared.items=items;
  if(kind==='files'&&computerState.pip===pip&&computerState.value?.granted){try{shared.desk=pipComputerFiles(await send('list_pip_computer_files',{pip_id:pip,path:''}),'').entries;}catch{shared.desk=null;}}}
 catch(error){if(token===scope()&&sequence===shared.seq)shared.error=errorText(error);}
 finally{if(token===scope()&&sequence===shared.seq){shared.loading=false;render();}}
}
function pipPageMarkup(){
 const p=S.pip,off=S.busy||!usable(),look=profile(p.profile);
 if(archived())return `<section class="pip-page-group"><p class="goal">${esc(p.goal)}</p><p class="muted">Archived. Its chat and results are saved. Restore it to use it again.</p>${lifecycleMarkup()}</section>`;
 if(S.pipPage==='instructions')return instructionsMarkup({esc,goal:draft.pipInstructions,busy:off,pipName:p.name});
 if(S.pipPage==='character'){
  const own=SIMPLE_CHARACTERS.includes(p.pip_type)?p.pip_type:'core',body=draft.lookBody||own;
  return characterMarkup({esc,body,color:draft.lookColor,busy:off,changed:lookDirty,avatarFor:(id,color,key,state='idle')=>avatar(state,characterType(id||own),`${key}-${p.id}`,color||'')});
 }
 const head=headMarkup({esc,avatar:pipAvatar(p,'idle',`page-${p.id}`,pipType(p,S.types)||characterType(p.pip_type)),name:p.name,title:look.title,nameDraft:draft.pipPageName,titleDraft:draft.pipPageTitle,busy:off,dirty:pageNameDirty});
 const tab=['links','media','files'].includes(S.pipPage)?S.pipPage:'info';
 if(tab!=='info'&&(shared.pip!==S.selected||shared.kind!==tab)&&!shared.loading)void loadShared(tab);
 const mine=shared.pip===S.selected&&shared.kind===tab,items=mine?shared.items:null,error=mine?shared.error:'',loading=!mine||shared.loading;
 const body=tab==='links'?linksMarkup(items,{esc,formatDate:shortDate,loading,error})
  :tab==='media'?mediaMarkup(items,{esc,imageSrc:messageImageSrc,loading,error})
  :tab==='files'?filesMarkup(items,mine?shared.desk:null,{esc,formatDate:shortDate,loading,error,hasComputer:computerState.pip===S.selected&&!!computerState.value?.granted})
  :infoMarkup({esc,goal:p.goal,routines:routinesSectionMarkup(),notify:look.notify,busy:off,canShare:S.apiVersion>=41&&!remoteHost&&['scout','lens','rook','lock','quill'].includes(p.pip_type),pipName:p.name})+computerRowMarkup(p,off)+(S.apiVersion>=53&&!remoteHost&&personalPip()?eyesMarkup(eyesState.pip===p.id?eyesState.value:null,{esc,busy:off||eyesState.busy,error:eyesState.error,pipName:p.name}):'')+(levelShown()?levelMarkup(levelState.pip===p.id?levelState.value:null,{esc,busy:off||levelState.busy,error:levelState.error,pipName:p.name,when:at=>shortDate(at)}):'')+(S.apiVersion>=44&&!remoteHost&&p.computer_plan?carefulMarkup(carefulState.pip===p.id?carefulState.value:null,{esc,busy:off||carefulState.busy,error:carefulState.error,pipName:p.name,showAll:sitesAll}):'')+(S.apiVersion>=56&&!remoteHost&&p.computer_plan?loginsMarkup(loginsState.pip===p.id?loginsState.value:null,{esc,busy:off||loginsState.busy,error:loginsState.error,pipId:p.id,pipName:p.name,names:pipNames(),confirm:loginsState.confirm}):'')+(S.apiVersion>=44&&!remoteHost?notesMarkup(S.notesPip===p.id?S.notes:null,{esc,busy:off||notesBusy,error:S.notesError,pipName:p.name,adding:draft.noteAdd,confirmAll:noteConfirmAll}):'')+(workingNotesShown()?workingNotesMarkup(S.workingNotesPip===p.id?S.workingNotes:null,{esc,busy:off||workingNotesBusy,error:S.workingNotesError,pipName:p.name,editing:workingNotesEditing,text:draft.workingNotesText})+dailyLogMarkup(S.dailyLogPip===p.id?S.dailyLog:null,{esc,error:S.dailyLogError,pipName:p.name,today:localDay()}):'')+allowedMarkup()+(S.apiVersion>=44&&!remoteHost?pluginsPageMarkup(S.plugins,{esc,busy:off||!!pluginBusy,pipName:p.name}):'');
 return `<div class="pip-page">${head}${pageTabsMarkup(tab)}<div class="pip-page-body" data-page="${tab}">${body}</div></div>`;
}
// What it may do without asking (an Always allow you gave): only shown when there is one, and each
// can be taken back here, as its Allow card promises.
function allowedMarkup(){
 if(S.apiVersion<41)return '';
 if(grantsState.pip!==S.selected){void loadGrants();return '';}
 const grants=grantsState.value?.grants||[];if(!grants.length)return '';
 const off=S.busy||!usable();
 return `<section class="pip-page-group" aria-label="Allowed without asking"><h3 class="pip-page-label">Allowed without asking</h3><ul class="pip-page-list">${grants.map(x=>`<li class="pip-page-row static"><span class="row-words"><span>${esc(x.label)}</span><small>${x.account==='connection_managed'?'The account its connection uses':esc(x.account)}</small></span><button type="button" class="quiet pill" data-revoke-grant="${esc(x.id)}"${off?' disabled':''}>Stop allowing</button></li>`).join('')}</ul></section>`;
}
function pipPageMenu(){
 const p=S.pip,off=S.busy||!usable();
 return `<button type="button" data-tab="runs">${historyName('Results')}</button>${S.apiVersion>=14&&!(S.apiVersion>=44&&personalPip())?'<button type="button" data-tab="memory">Memory</button>':''}<hr>`
  +'<button type="button" data-copy-pip-id>Copy ID</button>'
  +(archived()?'':`<button type="button" id="toggle-pip"${off||S.apiVersion>=16&&!canLifecycle()?' disabled':''}>${p.status==='paused'?'Resume':'Pause'}</button>`)
  +(S.apiVersion>=16&&canLifecycle()?(archived()?`<button type="button" id="restore-pip"${off?' disabled':''}>Restore…</button>`:`<button type="button" id="archive-pip" class="danger-text"${off?' disabled':''}>Archive…</button>`):'');
}
// Settings for all your Pips (from the Pips home): their computers, and the apps they use.
async function loadPipsSettings(){
 if(remoteHost||S.apiVersion<43||!usable())return;
 const token=S.epoch,sequence=++pipsSettings.seq,view=pipsSettings.view;
 try{if(view==='plugins'){const uses=pluginUsesPage(await send('list_pip_plugin_uses'));if(token!==S.epoch||sequence!==pipsSettings.seq)return;pipsSettings.plugins=uses;pipsSettings.pluginsError='';}
  else if(view==='apps'){const [listed]=await Promise.all([send('list_pip_apps'),loadOwnApps()]);const apps=appsPage(listed);if(token!==S.epoch||sequence!==pipsSettings.seq)return;pipsSettings.apps=apps;pipsSettings.appsError='';
   if(S.apiVersion>=44){const v=await send('get_pips_limit');if(token===S.epoch&&record(v)&&Number.isSafeInteger(v.max_pips)){pipsSettings.limit=v;if(draft.pipsMax==='')draft.pipsMax=String(v.max_pips);}}}
  else{const value=computersPage(await send('get_pip_computers'));if(token!==S.epoch||sequence!==pipsSettings.seq)return;pipsSettings.computers=value;pipsSettings.computersError='';
   if(value.setup.state==='running'||value.computers.some(c=>c.resetting))window.setTimeout(()=>{if(pipsSettings.view==='computer'&&!disposed)void loadPipsSettings();},3000);}}
 catch(error){if(token===S.epoch&&sequence===pipsSettings.seq){if(view==='plugins')pipsSettings.pluginsError=errorText(error);else if(view==='apps')pipsSettings.appsError=errorText(error);else pipsSettings.computersError=errorText(error);}}
 finally{if(token===S.epoch)render();}
}
async function pipsSettingsCall(command,args,notice){
 if(pipsSettings.busy||!usable())return;const token=S.epoch;pipsSettings.busy=true;render();
 try{const result=await send(command,args);if(token!==S.epoch)return;S.notice=typeof notice==='function'?notice(result):notice;pipsSettings.confirmReset='';await loadPipsSettings();}
 catch(error){if(token===S.epoch){if(pipsSettings.view==='plugins')pipsSettings.pluginsError=errorText(error);else if(pipsSettings.view==='apps')pipsSettings.appsError=errorText(error);else pipsSettings.computersError=errorText(error);}}
 finally{pipsSettings.busy=false;if(token===S.epoch)render();}
}
function pipsSettingsMarkup(){
 const view=['apps','plugins'].includes(pipsSettings.view)&&(pipsSettings.view!=='plugins'||S.apiVersion>=44)?pipsSettings.view:'computer',busy=pipsSettings.busy||S.busy||!usable();
 const tabs=`<nav class="pip-page-tabs" aria-label="Pips settings">${[['computer','Computer'],['apps','Apps'],...(S.apiVersion>=44?[['plugins','Plugins']]:[])].map(([k,l])=>`<button type="button" class="seg" data-pips-settings="${k}" aria-pressed="${view===k}">${l}</button>`).join('')}</nav>`;
 const body=view==='plugins'?pluginUsesMarkup(pipsSettings.plugins,{esc,busy,error:pipsSettings.pluginsError}):view==='apps'?ownAppsMarkup(S.apiVersion>=61?S.ownApps:[],{esc,busy,error:S.apiVersion>=61?S.ownAppsError:''})+appsSettingsMarkup(pipsSettings.apps,{esc,busy,error:pipsSettings.appsError,ownApps:S.apiVersion>=61&&(S.ownApps||[]).length>0})+(S.apiVersion>=43&&!remoteHost?`<section class="pip-page-group"><div class="pip-page-row static"><span class="row-words"><strong>Skills</strong><small>Your Pips use your DGC skills that fit everyday work: deep research, charts and planning, and the ones you add. A skill is instructions; it never gives a Pip new access.</small></span>${button('manage-skills','Manage skills…',false,'quiet pill')}</div></section>`:'')+(S.apiVersion>=44&&!remoteHost&&pipsSettings.limit?`<section class="pip-page-group"><form id="pips-limit-form" class="pip-page-row static"><span class="row-words"><label for="pipsMax"><strong>How many Pips you can have</strong></label><small>${pipsSettings.limit.default.toLocaleString('en-US')} unless you choose another number, up to ${pipsSettings.limit.maximum.toLocaleString('en-US')}. Archived Pips don’t count. A powerful computer can run thousands.</small></span><input id="pipsMax" data-draft="pipsMax" type="number" min="1" max="${pipsSettings.limit.maximum}" step="1" inputmode="numeric" value="${esc(draft.pipsMax)}" aria-label="How many Pips you can have"><button type="submit" class="quiet pill"${busy||String(pipsSettings.limit.max_pips)===draft.pipsMax?' disabled':''}>Save</button></form></section>`:'')
  :computersMarkup(pipsSettings.computers,{esc,busy,error:pipsSettings.computersError,formatDate:shortDate,confirming:pipsSettings.confirmReset});
 return `<header class="pip-topbar"><button type="button" id="pips-settings-close" class="topbar-icon" aria-label="Your Pips" title="Your Pips">${simpleIcon('back')}</button><div class="pip-pill settings-pill"><span>Pips settings</span></div><span></span></header><div class="simple-content"><div class="pip-page">${tabs}<div class="pip-page-body">${body}</div></div></div>`;
}
async function appLinkAction(type,id,quiet=false){
 if(!usable()||!personalPip()||(appLinkBusy&&!quiet))return;
 const token=scope(),pip=S.selected;if(!quiet){appLinkBusy=id;render();}
 try{
  const answer=appLinkResult(await send(type,{pip_id:pip,link_id:id}),pip,id);if(token!==scope()||S.selected!==pip)return;
  putAppLink(answer.link);if(answer.host)appLinkHosts.set(id,answer.host);
  if(type==='start_pip_app_link'&&answer.link.status==='authorizing'){appLinkUntil=Date.now()+5*60*1000;if(!answer.opened)S.notice='DGC could not open your browser. Choose Open sign-in again.';}
  if(answer.link.status==='connected'){S.notice=`${answer.link.app} is connected to ${S.pip?.name||'this Pip'}.`;void loadMessages();}
  else if(!quiet&&answer.error)S.notice=answer.error;
 }catch(error){if(token===scope()&&!quiet)setError(error);}
 finally{if(token===scope()){if(!quiet)appLinkBusy='';render();watchAppSignIn();}}
}
// While a sign-in is open in the browser, look every few seconds (for five minutes) so the card turns
// into "connected" by itself; "I've signed in" looks at once.
function watchAppSignIn(){
 window.clearTimeout(appLinkTimer);
 const open=(S.appLinks||[]).find(l=>l.status==='authorizing');
 if(!open||disposed||Date.now()>appLinkUntil)return;
 appLinkTimer=window.setTimeout(()=>{if(!disposed&&S.selected===open.pip_id)void appLinkAction('check_pip_app_link',open.id,true);},4000);
}
// Send on the Allow card: the Pip's connected Gmail account, its send tool, the exact saved draft, then
// one send (or Always allow). The same reviewed steps as the dialogs, without them.
let allowBusy='';const draftDetails=new Map();
// The draft list carries summaries; an Allow card shows the whole message, read once per version.
async function loadDraftDetails(){
 if(S.apiVersion<43||!personalPip()||!usable())return;
 const token=scope(),pip=S.selected;
 const waiting=list=>(list||[]).filter(d=>d.status==='pending'&&!d.expired&&!draftDetails.has(d.id+':'+d.digest)).slice(0,5);
 for(const d of [...waiting(S.emailDrafts),...(S.apiVersion>=35?waiting(S.calendarDrafts):[])]){
  const calendar=d.id.startsWith('caldraft_');
  try{const v=emailDraft((await send(calendar?'get_pip_calendar_draft':'get_pip_message_draft',{draft_id:d.id})).draft,pip,S.workspace.id,calendar);if(token!==scope()||S.selected!==pip)return;
   if(v.id===d.id&&v.digest===d.digest){draftDetails.set(d.id+':'+d.digest,v);render();}}
  catch{/* the Review row stays */}
 }
}
async function allowSend(id,always=false){
 const summary=(S.emailDrafts||[]).find(x=>x.id===id),d=summary&&draftDetails.get(summary.id+':'+summary.digest),link=connectedLink('gmail');
 if(!d||d.status!=='pending'||d.expired||!usable()||allowBusy)return;
 if(!link){void openEmailDraft(id);return;}
 const edit=cardEdit(d),token=scope(),pip=S.selected;let message;
 // What the card shows is what is sent: the fields as the user left them, checked before anything else.
 try{message=messageDraft(edit?{recipient_email:edit.values.recipient_email.trim(),subject:edit.values.subject.trim(),body:edit.values.body.trim()}:d.payload.message);}
 catch(error){cardError(edit,error);return;}
 const changed=edit&&JSON.stringify(message)!==JSON.stringify(d.payload.message);
 if(edit)edit.error='';allowBusy=id;render();
 try{
  const [discovery,inspection]=await Promise.all([send('list_pip_accounts',{server:link.server}),send('inspect_pip_send_connection',{server:link.server})]);
  if(token!==scope()||S.selected!==pip)return;
  const choice=sendAccounts(link.server,discovery,inspection).find(c=>c.id===link.account);
  if(!choice)throw Error(`${link.label||'This Gmail account'} is no longer in Composio. Ask ${S.pip?.name||'the Pip'} to connect Gmail again.`);
  const request={type:'prepare_pip_message_draft',draft_id:d.id,expected_digest:d.digest,server:link.server,connection_digest:discovery.connection_digest,account:choice.id,schema_digest:choice.schema_digest,message};
  const {type:_t,...fields}=request;
  const action=messageReview((await send('prepare_pip_message_draft',fields)).action,pip,S.workspace.id,{...request,source_run_id:d.source_run_id});
  if(token!==scope()||S.selected!==pip)return;
  await send(always?'always_allow_pip_app_action':'accept_pip_app_action',{action_id:action.id,expected_digest:action.digest});
  if(token!==scope())return;
  cardEdits.delete(id);
  S.notice=(changed?'Sent with your changes.':'Sent, exactly as shown.')+(always?` ${S.pip?.name||'This Pip'} may now send emails from ${link.label||'this account'} without asking; take it back in its Settings.`:'');
  void loadEmailDrafts();
 }catch(error){if(token===scope()){if(edit)cardError(edit,error);else setError(error);}}
 finally{if(token===scope()){allowBusy='';render();}}
}
// Add on a calendar card: the same steps as Send, for the Pip's connected Google Calendar.
async function allowCreate(id,always=false){
 const summary=(S.calendarDrafts||[]).find(x=>x.id===id),d=summary&&draftDetails.get(summary.id+':'+summary.digest),link=connectedLink('googlecalendar');
 if(!d||d.status!=='pending'||d.expired||!usable()||allowBusy)return;
 if(!link){void openEmailDraft(id);return;}
 const edit=cardEdit(d),token=scope(),pip=S.selected,saved=d.payload.event;let event;
 try{event=edit?editedEvent(saved,edit.values):calendarDraft(saved);}catch(error){cardError(edit,error);return;}
 const changed=edit&&JSON.stringify(event)!==JSON.stringify(saved);
 if(edit)edit.error='';allowBusy=id;render();
 try{
  const [discovery,inspection]=await Promise.all([send('list_pip_accounts',{server:link.server}),send('inspect_pip_calendar_connection',{server:link.server})]);
  if(token!==scope()||S.selected!==pip)return;
  const choice=calendarAccounts(link.server,discovery,inspection).find(c=>c.id===link.account);
  if(!choice)throw Error(`${link.label||'This Google Calendar account'} is no longer in Composio. Ask ${S.pip?.name||'the Pip'} to connect Google Calendar again.`);
  const request={type:'prepare_pip_calendar_draft',draft_id:d.id,expected_digest:d.digest,server:link.server,connection_digest:discovery.connection_digest,account:choice.id,schema_digest:choice.schema_digest,event};
  const {type:_t,...fields}=request;
  const action=messageReview((await send('prepare_pip_calendar_draft',fields)).action,pip,S.workspace.id,{...request,source_run_id:d.source_run_id});
  if(token!==scope()||S.selected!==pip)return;
  await send(always?'always_allow_pip_app_action':'accept_pip_app_action',{action_id:action.id,expected_digest:action.digest});
  if(token!==scope())return;
  cardEdits.delete(id);
  S.notice=(changed?'Added with your changes.':'Added, exactly as shown.')+(event.send_invitations?' Invitations went to the guests.':'')+(always?` ${S.pip?.name||'This Pip'} may now add events to ${link.label||'this calendar'} without asking; take it back in its Settings.`:'');
  void loadEmailDrafts(true);
 }catch(error){if(token===scope()){if(edit)cardError(edit,error);else setError(error);}}
 finally{if(token===scope()){allowBusy='';render();}}
}
// Editing a card: the fields as typed, per draft version. A new version from the Pip starts fresh.
const cardEdits=new Map();
function cardEdit(d){const e=d&&cardEdits.get(d.id);return e&&e.digest===d.digest?e:null;}
function cardError(edit,error){if(edit){edit.error=errorText(error);render();}else setError(error);}
function connectedLink(toolkit){return (S.appLinks||[]).find(l=>l.status==='connected'&&l.toolkit===toolkit)||null;}
function editedEvent(saved,v){
 const attendees=v.guests.split('\n').map(x=>x.trim()).filter(Boolean);
 const base={summary:v.summary.trim(),description:v.description.trim(),start_datetime:v.start_datetime.trim(),end_datetime:v.end_datetime.trim(),timezone:v.timezone.trim()};
 // Guests are invited: Google sends an invitation to each one, as the card says.
 return calendarDraft(extendedCalendar(saved)||attendees.length?{...base,attendees,send_invitations:attendees.length>0,repeat:saved.repeat??null}:base);
}
function startCardEdit(id){
 let values=null,digest='';
 if(id.startsWith('conndraft_')){const d=(S.connectorDrafts||[]).find(x=>x.id===id),found=d&&pluginDraft(d);if(found){digest=found.draft.digest;values=argumentValues(found.draft.payload.action.call.arguments||{});}}
 else{const calendar=id.startsWith('caldraft_'),summary=(S[calendar?'calendarDrafts':'emailDrafts']||[]).find(x=>x.id===id),d=summary&&draftDetails.get(summary.id+':'+summary.digest);
  if(d){digest=d.digest;const p=d.payload;values=calendar?{summary:p.event.summary,start_datetime:p.event.start_datetime,end_datetime:p.event.end_datetime,timezone:p.event.timezone,description:p.event.description,guests:(p.event.attendees||[]).join('\n')}:{...p.message};}}
 if(!values)return;
 cardEdits.set(id,{digest,values,error:''});render();
 document.querySelector(`[data-card-edit="${CSS.escape(id)}"]`)?.focus();
}
async function allowDismiss(id){
 const calendar=id.startsWith('caldraft_'),d=(S[calendar?'calendarDrafts':'emailDrafts']||[]).find(x=>x.id===id);if(!d||S.busy||!usable())return;
 void mutate({type:calendar?'dismiss_pip_calendar_draft':'dismiss_pip_message_draft',draft_id:d.id,expected_digest:d.digest},r=>{const v=emailDraft(r.draft,S.selected,S.workspace.id,calendar);if(v.id!==d.id||v.status!=='dismissed')throw Error('The dismissal does not match this draft.');cardEdits.delete(id);S.notice=calendar?'Not added.':'Not sent.';void loadEmailDrafts(calendar);});
}
async function openEmailDraft(id){
 if(id.startsWith('conndraft_')){await openConnectorDraft(id);return;}
 const calendar=id.startsWith('caldraft_');
 if(remoteHost||S.apiVersion<(calendar?35:32)||!personalPip()||!usable())return;
 const command=calendar?'get_pip_calendar_draft':'get_pip_message_draft';
 openReview({title:calendar?'Calendar event':'Email',description:calendar?'Loading the event. Nothing is added.':'Loading the email. Nothing is sent.',readOnly:true,body:'<p>Loading…</p>',request:{type:command,draft_id:id}});const ticket=S.review;
 try{const value=emailDraft((await send(command,{draft_id:id})).draft,S.selected,S.workspace.id,calendar);if(S.review!==ticket||ticket.scope!==scope())return;if(value.id!==id)throw Error('The returned draft does not match this review.');
 if(value.status==='prepared'){await openMessageReview(value.action_id);return;}
 const available=value.status==='pending'&&!value.expired&&!archived();ticket.emailDraft=value;ticket.calendarAction=calendar;ticket.readOnly=!available;ticket.confirm='Next';ticket.description=available?(calendar?'Choose the calendar to add it to. You’ll see the event again before it’s added.':'Choose the account to send from. You’ll see the email again before it’s sent.'):value.expired?'This draft has expired. Ask for a new draft.':'This draft was dismissed.';
 const e=value.payload.event;
 ticket.body=calendar?`<dl class="meta"><dt>Title</dt><dd>${esc(e.summary)}</dd><dt>Start</dt><dd>${esc(e.start_datetime)}</dd><dt>End</dt><dd>${esc(e.end_datetime)}</dd><dt>Time zone</dt><dd>${esc(e.timezone)}</dd>${calendarExtras(e)}</dl><pre class="message-review-body">${esc(e.description)}</pre><p class="muted">No account selected. No event created. Edit these details after choosing an account.</p>`:`<dl class="meta"><dt>To</dt><dd>${esc(value.payload.message.recipient_email)}</dd><dt>Subject</dt><dd>${esc(value.payload.message.subject)}</dd></dl><pre class="message-review-body">${esc(value.payload.message.body)}</pre><p class="muted">No sending account selected. Nothing sent.</p>`;
 ticket.body+=available?'<button type="button" id="dismiss-email-draft">Dismiss draft</button>':'';renderReview();
 }catch(error){if(S.review===ticket){ticket.error=errorText(error);renderReview();}}
}
async function emailDraftHistory(before=null,calendar=false){
 if(remoteHost||S.apiVersion<(calendar?35:32)||!personalPip()||!usable())return;
 const command=calendar?'list_pip_calendar_drafts':'list_pip_message_drafts';
 openReview({title:calendar?'Calendar drafts':'Email drafts',description:`Drafts ${S.pip?.name||'it'} wrote. Nothing is sent until you OK it.`,readOnly:true,body:'<p>Loading…</p>',request:{type:command,pip_id:S.selected}});const ticket=S.review;
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
 const p=a.payload,e=p.event,pending=a.status==='pending';if(extendedCalendar(e)&&S.apiVersion<38)throw Error('Update DGC to send invitations or repeat an event, then reload.');
 openReview({title:pending?'Review calendar event':a.status==='succeeded'?'Calendar event created':messageStates[a.status],description:pending?`This adds exactly this event (or series), with the listed invitations, once. Always allow also lets ${S.pip?.name||'this Pip'} add events without asking.`:a.status==='succeeded'?'Google Calendar confirmed the reviewed event or series. Invitation delivery and acceptance are not confirmed.':['unknown','dispatching'].includes(a.status)?'Creation is unconfirmed. Check the calendar or Composio log before preparing another event. DGC will not retry this action.':'This review cannot create an event.',readOnly:!pending,blocked:archived(),confirm:calendarDetails(e).confirm,expiresAt:a.expires_at,messageAction:a.id,messageDigest:a.digest,
 body:`<dl class="meta"><dt>Connection</dt><dd>${esc(p.server)}</dd><dt>Account</dt><dd>${esc(p.account)}</dd><dt>Calendar</dt><dd>Primary</dd><dt>Title</dt><dd>${esc(e.summary)}</dd><dt>Start</dt><dd>${esc(e.start_datetime)}</dd><dt>End</dt><dd>${esc(e.end_datetime)}</dd><dt>Time zone</dt><dd>${esc(e.timezone)}</dd>${calendarExtras(e)}</dl><pre class="message-review-body">${esc(e.description)}</pre><p class="muted">Private and busy; invitees can see event details. No meeting link. The provider expands repeats in the named time zone; invalid dates or local times may be skipped. Calendar reminders, sharing and administrator access still apply. Review expires ${esc(date(a.expires_at))}.</p>${pending?'<button type="button" id="reject-message-review">Reject event</button>':''}`,always:pending,request:{type:'accept_pip_app_action',action_id:a.id,expected_digest:a.digest}});
}
async function loadConnectorDrafts(){
 if(remoteHost||S.apiVersion<37||!personalPip()||!usable())return;const token=scope(),seq=++connectorDraftSeq;
 try{const result=connectorDraftsPage(await send('list_pip_connector_drafts',{pip_id:S.selected,limit:20}),S.selected);if(token!==scope()||seq!==connectorDraftSeq)return;S.connectorDrafts=result.drafts;S.connectorDraftError='';render();void loadPluginDrafts();void loadOwnAppDecisions();}catch(error){if(token===scope()&&seq===connectorDraftSeq){S.connectorDraftError=errorText(error);render();}}
}
async function openConnectorDraft(id){
 if(remoteHost||S.apiVersion<37||!personalPip()||!usable())return;
 openReview({title:'App action',description:'Loading it. Nothing runs.',readOnly:true,body:'<p>Loading…</p>',request:{type:'get_pip_connector_draft',draft_id:id}});const ticket=S.review;
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
 openReview({title:pending?'Review connector action':actionStatus(a),description:pending?'Run once does this one thing, once. The connected service decides which account it uses; check it there before you run it.':a.status==='succeeded'?a.receipt.meaning:['unknown','dispatching'].includes(a.status)?'The action may still be running at the provider. DGC will not retry an uncertain attempt.':'This review is closed. No further attempt can be approved.',readOnly:!pending,blocked:archived(),confirm:'Run once',expiresAt:a.expires_at,messageAction:a.id,messageDigest:a.digest,connectorSummary:p.call.arguments,
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
 ticket.messageForm={source,server,fingerprint:discovery.connection_digest,choices,key:window.crypto.randomUUID(),savedDraft,calendar};ticket.readOnly=false;ticket.confirm='Save';ticket.description='Edit the email. Saving doesn’t send it.';
 ticket.body=`<div class="form"><label for="message-account">Gmail account</label><select id="message-account"><option value="">Choose an account…</option>${choices.map((c,i)=>`<option value="${i}">${esc(c.label)} · ${esc(c.id)}</option>`).join('')}</select><label for="message-recipient">To</label><input id="message-recipient" type="email" autocomplete="off" maxlength="254" value="${esc(savedDraft?.payload.message?.recipient_email||'')}"><label for="message-subject">Subject</label><input id="message-subject" maxlength="200" value="${esc(savedDraft?.payload.message?.subject||'')}"><label for="message-body">Message</label><textarea id="message-body" rows="8" maxlength="12000">${esc(savedDraft?.payload.message?.body||'')}</textarea></div><p class="muted">One recipient, plain text, no attachments or CC. You have 24 hours to send it.</p><p id="message-form-error" role="alert" class="error"></p>`;
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
 openReview({title:pending?'Send this email?':messageStates[a.status],description:pending?`Send sends it once. Always allow also lets ${S.pip?.name||'this Pip'} send from this account without asking.`:a.status==='succeeded'?'Sent. Gmail accepted it; DGC can’t see whether it arrived.':['unknown','dispatching'].includes(a.status)?'DGC doesn’t know if this was sent and won’t try again. Check your Gmail Sent folder before sending it again.':'This email can’t be sent from here.',readOnly:!pending,blocked:archived(),confirm:'Send once',expiresAt:a.expires_at,messageAction:a.id,messageDigest:a.digest,
 body:`<dl class="meta"><dt>From</dt><dd>${esc((S.appLinks||[]).find(l=>l.account===p.account)?.label||p.account)}</dd><dt>To</dt><dd>${esc(p.message.recipient_email)}</dd><dt>Subject</dt><dd>${esc(p.message.subject)}</dd></dl><pre class="message-review-body">${esc(p.message.body)}</pre><p class="muted">Plain text, no attachments.${pending?` Send by ${esc(date(a.expires_at))}.`:''}</p>${pending?'<button type="button" id="reject-message-review">Don’t send</button>':''}`,always:pending,request:{type:'accept_pip_app_action',action_id:a.id,expected_digest:a.digest}});
}
async function openMessageReview(id){
 if(!canReviewMessages())return;
 openReview({title:'External action review',description:'Loading the exact saved action.',readOnly:true,body:'<p>Loading…</p>',request:{type:'get_pip_app_action',action_id:id}});const ticket=S.review;
 try{const answer=await send('get_pip_app_action',{action_id:id});if(S.review!==ticket||ticket.scope!==scope())return;if(answer.action?.id!==id)throw Error('The returned review does not match the selected action.');showMessageReview(answer.action);}catch(error){if(S.review===ticket){ticket.error=errorText(error);renderReview();}}
}
async function messageReviews(before=null){
 if(!canReviewMessages())return;
 openReview({title:'External action reviews',description:'Each one waits for your OK, unless you chose Always allow for that kind.',readOnly:true,body:'<p>Loading reviews…</p>',request:{type:'list_pip_app_actions',pip_id:S.selected}});const ticket=S.review;
 try{const answer=messageHistory(await send('list_pip_app_actions',{pip_id:S.selected,...(before?{before_id:before}:{}),limit:20}),S.selected);if(S.review!==ticket||ticket.scope!==scope())return;
 ticket.body=answer.actions.length?answer.actions.map(a=>`<article class="entry"><button type="button" data-message-review="${esc(a.id)}">${esc(a.subject)}</button><p class="muted">${esc(a.recipient)} · ${esc(actionStatus(a))}</p></article>`).join(''):'<p>No external action reviews yet. Open a completed Personal result to prepare an email or calendar event.</p>';
 if(answer.next_cursor)ticket.body+=`<button type="button" data-message-more="${esc(answer.next_cursor)}">Older reviews</button>`;renderReview();
 }catch(error){if(S.review===ticket){ticket.error=errorText(error);renderReview();}}
}

function closeReview() { if(computerViewTimer){clearInterval(computerViewTimer);computerViewTimer=null;} const wasOpen=!!S.review;S.review=null;clearLoginForm($('review-root'));$('review-root').innerHTML='';$('app').inert=false; if(wasOpen) render(); if(dialogReturn) { const target=dialogReturn.id?$(dialogReturn.id):[...document.querySelectorAll('button')].find(b=>Object.entries(dialogReturn.data).some(([k,v])=>b.dataset[k]===v)); target?.focus({preventScroll:true}); } }
function openReview(review) { dialogReturn={id:document.activeElement?.id||'',data:{...document.activeElement?.dataset}}; S.review={...review,scope:scope(),request:JSON.parse(JSON.stringify(review.request)),error:''}; render(); renderReview(); }
const reviewBlocked=r=>!!r.blocked || (r.setup&&(S.apiVersion<23||r.setup.pip_type==='pulse'&&S.apiVersion<27)) || (r.requiresCommitPaths&&S.apiVersion<22) || (r.requiresPulsePlan&&S.apiVersion<21) || (r.requiresQuillAutomation&&S.apiVersion<20) || (r.requiresSessionTurn&&S.apiVersion<18) || (r.commandOutcome&&S.apiVersion<17) || (r.requiresSpecialists&&S.apiVersion<15) || (r.requiresExecution&&S.executionCapability?.available!==true) || (r.expiresAt && Number.isFinite(Date.parse(r.expiresAt)) && Date.parse(r.expiresAt)<=Date.now());
function renderReview() {
  const r=S.review;if(!r)return;
  $('app').inert=true;
  if(r.loginForm){renderLoginForm(r);return;}
  $('review-root').innerHTML=`<div class="overlay"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="review-title"><h2 id="review-title" tabindex="-1">${esc(r.title)}</h2><p>${esc(r.description)}</p>${r.body||''}${r.reasonRequired&&r.note?`<label>${esc(r.note)}<textarea id="findingReviewReason" data-draft="findingReviewReason"${S.busy?' disabled':''}>${esc(draft.findingReviewReason)}</textarea></label>`:''}${r.memoryRecord?`<label>Optional expiry, with time zone<input id="memoryExpiry" data-draft="memoryExpiry" value="${esc(draft.memoryExpiry)}" placeholder="2026-12-01T09:00:00Z"${S.busy?' disabled':''}></label><p class="muted">Leave empty for no automatic expiry. The source and job scope stay explicit.</p>`:''}${errorMarkup(r.error)}<div class="actions">${r.secondary?button(r.secondary.id,r.secondary.label,S.busy||!usable(),'secondary-action'):''}${button('review-cancel',r.readOnly?'Close':'Cancel',S.busy)}${r.always&&!r.readOnly&&S.apiVersion>=41?button('review-always','Always allow',S.busy||!usable()||reviewBlocked(r)):''}${r.readOnly?'':button('review-confirm',S.busy?'Applying…':r.confirm,S.busy||!usable()||reviewBlocked(r),r.danger?'danger':'primary')}</div></section></div>`;
  if(r.connectorSummary)mountConnectorSummary($('connector-review-values'),r.connectorSummary);
  if(r.connectorForm){
    const form=r.connectorForm,select=$('connector-tool');select.value=String(form.selected);select.disabled=S.busy;
    const mount=()=>{$('connector-description').textContent=form.inspection.tools[form.selected].description;mountConnectorInputs($('connector-fields'),form.inputs[form.selected],S.busy);};
    select.addEventListener('change',()=>{const index=Number(select.value);if(Number.isSafeInteger(index)&&form.inspection.tools[index]){form.selected=index;mount();}});mount();
  }
  $('review-title')?.focus({preventScroll:true});document.querySelector('[role=dialog]')?.scrollTo?.(0,0);
}
function clearSelection() { S.notes=null;S.notesPip='';S.notesError='';notesSeq++;noteConfirmAll=false;draft.noteAdd='';S.workingNotes=null;S.workingNotesPip='';S.workingNotesError='';workingNotesSeq++;workingNotesEditing=false;draft.workingNotesText='';S.dailyLog=null;S.dailyLogPip='';S.dailyLogError='';dailyLogSeq++;S.appLinks=[];S.appLinksError='';S.plugins=[];S.pluginsInstalled=[];S.pluginsError='';pluginSeq++;pluginBusy='';S.routines=null;S.routinesError='';routineSeq++;routineEditing='';routineError='';S.pipPage='info';S.legacyOpen=false;pageNameDirty=false;lookDirty=false;shared.pip='';shared.seq++;window.clearTimeout(appLinkTimer);appLinkBusy=''; S.editingGoal=false;S.quickDirty=false;connectorDraftSeq++;S.connectorDrafts=[];S.connectorDraftError=""; calendarDraftSeq++;S.calendarDrafts=[];S.calendarDraftError="";emailDraftSeq++;S.emailDrafts=[];S.emailDraftError=""; chatActivities.clear(); S.composerPanel='';S.chatControls=null;S.continuity=null;draft.chatModelSearch=''; statementSeq++;statementAnchorSeq++;statementRows=[];statementPage=null;statementLoaded=false;statementLoading=false;statementError='';statementInspecting=false;statementRetry=null;draft.statementKind='fact';draft.statementTitle='';draft.statementText='';draft.statementReason='';draft.statementExpiry='';draft.statementSource=''; memorySeq++;memorySourceSeq++;memories=[];memoryCursor=null;memoryLoaded=false;memoryLoading=false;memoryError='';draft.memoryExpiry='';resetOutcomes(); S.sourceDirty=false;S.sourceDraftVersion=null;draft.sourceReason=''; adaptationSeq++;S.adaptations=[];S.adaptationCursor=null;S.adaptationsLoaded=false;S.adaptationsLoading=false;S.adaptationsError='';S.adaptationDirty=false;S.adaptationDraftVersion=null;draft.adaptationReason='';handoffSeq++;handoffDetailSeq++;S.handoffs=[];S.handoffCursor=null;S.handoffsLoaded=false;S.handoffsLoading=false;S.handoffsError='';S.handoffDraft=null;checkpointSeq++;S.checkpoints=[];S.checkpointCursor=null;S.checkpointsLoaded=false;S.checkpointsLoading=false;S.checkpointsError='';draft.findingReviewReason='';selectionGeneration++;if(S.selected)chatDrafts.set(S.selected,draft.chatText);postsSeq++;S.posts=[];S.postsCursor=null;S.postsPip='';S.postsLoaded=false;S.postsLoading=false;S.postsError='';messageSeq++;streamSeq++;streamLoading=false;S.stream=null;S.messages=[];S.messageCursor=null;S.messagesLoaded=false;S.messagesLoading=false;S.messagesError='';S.chatActiveRun=null;S.omitted=0;S.modelDirty=false;draft.modelReason='';S.busy=false;approvalSeq++;S.approvals=[];S.approvalCursor=null;S.approvalsLoaded=false;S.approvalsLoading=false;S.approvalsError='';S.scheduleDirty=false;S.scheduleDraftVersion=null;draft.scheduleReason=''; activitySeq++;S.activity=null;S.activityLoading=false;S.activityError=''; selectionSeq++;detailSeq++;historySeq++;S.pip=null;S.runs=[];S.run=null;S.runId='';S.versions=[];S.cursor=null;S.historyLoaded=false;draft.revisionGoal='';draft.revisionReason='';closeReview(); }
// "Report ready", "Last run failed": the Pip page's status names its latest run, so it opens that run (the founder,
// 19 Oct: it read like a link and did nothing). A status that names no finished run stays words.
// Since its runs post in its chat (API 51), the status says what the latest found and goes to that post.
function lastRunLink(p,label){
 const latest=record(p?.latest_run)?p.latest_run:S.runs[0];
 if(!record(latest)||typeof latest.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(latest.id)||!['succeeded','failed','cancelled'].includes(latest.status)||active(p?.active_run?.status))return esc(label);
 const post=postsShown()&&S.postsPip===p?.id?postFor(latest.id):null;
 if(post)return `<button type="button" class="link last-run" data-last-post="${esc(post.run_id)}" title="See it in the chat">${esc(postStatus(post))}</button>`;
 return `<button type="button" class="link last-run" data-last-run="${esc(latest.id)}" title="Open this run">${esc(label)}</button>`;
}
async function loadRun(id) {
  if(id!==S.runId){activitySeq++;S.activity=null;S.activityLoading=false;S.activityError='';}
  S.runId=id;const sequence=++detailSeq;const token=scope();render();
  try { const answer=await send('get_pip_run',{run_id:id});if(token!==scope()||sequence!==detailSeq||id!==S.runId)return;if(!record(answer.run)||answer.run.id!==id||answer.run.pip_id!==S.selected)throw new Error('Run did not match the selected Pip.');const wasActive=active(S.run?.status);S.run=answer.run;render();if(S.activity&&!S.activity.has_more&&(wasActive||active(S.run.status)))void loadActivity();void loadRunSource(id); }
  catch(error){if(token===scope()&&sequence===detailSeq)setError(error);}
}
async function loadSelected(chooseLatest=false) {
  if(!S.selected)return;const id=S.selected,sequence=++selectionSeq,token=scope();
  try{const [p,r]=await Promise.all([send('get_pip',{pip_id:id}),send('list_pip_runs',{pip_id:id})]);if(token!==scope()||sequence!==selectionSeq)return;
    if(!record(p.pip)||p.pip.id!==id||p.pip.workspace_id!==S.workspace.id||!Array.isArray(r.runs)||!r.runs.every(run=>run.pip_id===id))throw new Error('Pip details do not match this workspace.');
    S.pip=p.pip;S.runs=r.runs;if(!S.modelDirty)draft.pipModel=modelValue(p.pip.model_choice);if(!S.scheduleDirty)hydrateSchedule(p.pip);if(!S.quickDirty)hydrateQuickSchedule(p.pip);if(!S.adaptationDirty)hydrateAdaptation(p.pip);if(!S.sourceDirty)hydrateSource(p.pip);if(!draft.revisionGoal)draft.revisionGoal=p.pip.goal;render();void loadPosts();
    const desired=S.runId||(chooseLatest?r.runs.find(run=>run.manifest?.run_kind!=='conversation')?.id:'');if(desired&&S.tab!=='chat')await loadRun(desired);if(S.tab==='chat')await loadMessages();
  }catch(error){if(token===scope()&&sequence===selectionSeq)setError(error);}
}
async function select(id) {if(id===S.selected&&!S.create){S.overview=false;S.tab='chat';rememberView();render();void loadMessages();return;}clearSelection();S.selected=id;S.create=false;S.overview=false;S.tab='chat';draft.chatText=chatDrafts.get(id)||'';chatHistory?.reset();S.error='';rememberView();render();await loadSelected(true);}
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
  if(!usable()||!S.workspace)return;const token=scope(),epoch=S.epoch,sequence=++refreshSeq;S.refreshing=true;void loadSetups();void loadAttention();
  try {
    const paged=pipsPaged();
    const results=await Promise.allSettled([send('list_pips',{workspace_id:S.workspace.id,...(paged?{order:'recent',limit:100,...(S.pipSearch?{query:S.pipSearch}:{})}:{})}),send('get_pip_runner'),...(includeContext?[send('get_workspace_context',{workspace_id:S.workspace.id})]:[])]);
    if(token!==scope())return;
    if(results[0].status==='fulfilled'){const jobs=results[0].value.pips;if(!Array.isArray(jobs)||!jobs.every(p=>p.workspace_id===S.workspace.id))throw new Error('Pips list does not match this workspace.');S.jobs=paged?mergePage(jobs,results[0].value):jobs;}else S.error=errorText(results[0].reason);
    if(results[1].status==='fulfilled'){S.runner=null;S.runner=runner(results[1].value.runner);}else{S.runner=null;S.error=errorText(results[1].reason);}
    if(includeContext){if(results[2].status==='fulfilled'){S.context=null;S.context=context(results[2].value.context,S.workspace.id);}else{S.context=null;S.error=errorText(results[2].reason);}}
    if(S.selected&&!S.jobs.some(p=>p.id===S.selected)&&paged&&S.pip?.id===S.selected)S.jobs=[...S.jobs,S.pip];
    if(S.selected&&!S.jobs.some(p=>p.id===S.selected)){clearSelection();S.selected='';}
    if(restoreView&&!S.create){restoreView=false;if(savedView?.workspace_id===S.workspace.id&&record(savedView.drafts))for(const [id,text] of Object.entries(savedView.drafts).slice(-20))if(typeof text==='string'&&text.length<=4000)chatDrafts.set(id,text);if(savedView?.workspace_id===S.workspace.id&&!savedView.overview&&S.jobs.some(p=>p.id===savedView.selected))await select(savedView.selected);}if(S.selected)await loadSelected(false);
  }catch(error){if(token===scope())S.error=errorText(error);}
  finally{if(epoch===S.epoch&&sequence===refreshSeq){S.refreshing=false;render();}}
}
async function initialize() {
  const epoch=S.epoch;S.loading=true;render();
  try {const [result,catalog]=await Promise.all([send('list_workspaces'),send('list_pip_types')]);if(epoch!==S.epoch)return;S.types=pipTypes(catalog);S.workspaces=result.workspaces||[];S.currentWorkspaceId=typeof result.current_workspace_id==='string'?result.current_workspace_id:null;S.projectEmpty=false;S.switching=false;const personalHome=S.apiVersion>=43&&!remoteHost?result.workspaces?.find(w=>w.kind==='personal')?.id:null;let workspace;
   if(!options.workspaceId&&scopeTabs()){
    // The tab chosen last in this window; else Personal (Pips API 43), else this folder's project. Only ever these two.
    const personal=personalSpace(),project=projectSpace(),saved=record(savedView)?savedView:{};
    const wantsProject=saved.scope_tab==='project'||!!project&&saved.workspace_id===project.id;
    workspace=wantsProject?project||personal:saved.workspace_id===personal.id||personalHome?personal:project||personal;
    S.projectEmpty=wantsProject&&!project;
   }else workspace=result.workspaces?.find(w=>w.id===(options.workspaceId||(savedView?.workspace_id&&result.workspaces.some(w=>w.id===savedView.workspace_id&&w.kind==='personal')?savedView.workspace_id:personalHome||result.current_workspace_id)));
   if(!workspace)throw new Error('DGC could not resolve the selected registered workspace.');S.workspace=workspace;S.loading=false;await refresh(true);if(epoch===S.epoch&&navigationPending){navigationPending=false;await navigateFromHost(options.navigation);}}
  catch(error){if(epoch===S.epoch){S.loading=false;setError(error);}}
}
async function navigateFromHost(value) {
  if(!record(value))return;
  S.projectEmpty=false;   // whatever it opens is shown under its own tab
  if(value.attention===true||typeof value.setup==='string'){await navigateAttention(value);return;}
  if(['context','notifications'].includes(value.section)&&!value.pip){clearSelection();S.selected='';S.tab=value.section;S.overview=false;rememberView();render();if(S.tab==='notifications'){await loadNotifications();return;}if(S.apiVersion>=12){void loadOutcomeSessions();void loadOutcomes();if(value.reviewKind==='session_outcome'&&typeof value.review==='string'&&value.review)await openOutcome(value.review);}return;}
  if(typeof value.pip!=='string'||!value.pip)return;
  if(!remoteHost&&['email_draft','calendar_draft','connector_draft'].includes(value.reviewKind)&&S.apiVersion>=(value.reviewKind==='connector_draft'?37:value.reviewKind==='calendar_draft'?35:32)&&value.workspace!==S.workspace.id){
    const token=scope(),answer=await send(value.reviewKind==='connector_draft'?'get_pip_connector_draft':value.reviewKind==='calendar_draft'?'get_pip_calendar_draft':'get_pip_message_draft',{draft_id:value.review});if(token!==scope())return;
    if((value.reviewKind==='connector_draft'?connectorDraft(answer.draft,value.pip,value.workspace):emailDraft(answer.draft,value.pip,value.workspace,value.reviewKind==='calendar_draft')).id!==value.review)throw Error('The saved email draft identity changed.');
    const target=S.workspaces.find(w=>w.id===value.workspace&&w.kind==='personal');
    if(!target)throw Error('The Personal workspace for this draft is unavailable.');
    await enterWorkspace(target);
  }
  if(!S.jobs.some(p=>p.id===value.pip)){
   // A Pip opened from elsewhere (a chat's run line, a notification, the Sessions home) may be past the pages read
   // so far, or another workspace's: a project's Pip while Personal shows (the founder, 2026-10-18, saw only Core and
   // "not available in the selected workspace"). Read it, open its own workspace, then it. One that is gone says so
   // (get_pip: "That Pip isn’t on this computer").
   const found=(await send('get_pip',{pip_id:value.pip})).pip;
   if(!record(found)||found.id!==value.pip||typeof found.workspace_id!=='string')throw Error('That Pip isn’t on this computer any more. It may have been deleted.');
   if(found.workspace_id!==S.workspace.id){
    // Only Personal and this folder's project (the founder, 2026-10-21): another project's Pip is not opened here.
    let target=openableSpaces().find(w=>w.id===found.workspace_id);
    if(!target){const listed=await send('list_workspaces');if(Array.isArray(listed?.workspaces)){S.workspaces=listed.workspaces;if(typeof listed.current_workspace_id==='string')S.currentWorkspaceId=listed.current_workspace_id;}target=openableSpaces().find(w=>w.id===found.workspace_id);}
    const name=typeof found.name==='string'&&found.name?found.name:'This Pip';
    if(!target)throw Error(scopeTabs()?`${name} is another project’s Pip. Open that project’s folder to see it.`:`${name} belongs to a project this Pips view can’t open.`);
    await enterWorkspace(target);
   }
   if(!S.jobs.some(p=>p.id===found.id))S.jobs=[...S.jobs,found];
  }
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
  if(S.busy||!usable())return;if(archived()&&['propose_pip_update','accept_pip_update','reject_pip_update','propose_pip_handoff','propose_pip_artifact_handoff','accept_pip_handoff','pause_pip','resume_pip','run_pip','send_pip_message','record_pip_statement'].includes(request.type)){setError(`${S.pip?.name||'This Pip'} is archived. Restore it in Settings first.`);return;}const token=scope();S.busy=true;S.error='';render();if(S.review)renderReview();
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
 // A saved job leaves out live_plan when it has none, so taking the commands away is a difference too.
 if(JSON.stringify(d.live_plan??null)!==JSON.stringify(p.live_plan??null))parts.push(d.live_plan?'Live-data commands':'No live-data commands');
 return parts.join(' · ')||String(v.reason||'A saved change');
}
// A change the user makes in this view is theirs: it is saved and accepted in one step, with the
// reason filled in. `same` checks the saved definition matches the choice before accepting it.
/** The backend's sentence about Keep Pips running after a schedule, trigger or routine was saved. */
function keepRunningTold(result){if(typeof result?.keep_running_notice!=='string'||!result.keep_running_notice)return '';keepState.asked=false;return ' '+result.keep_running_notice;}
async function applyOwnChange(changes,same,notice){
 if(S.busy||!usable()||!S.pip)return false;const pip=S.pip,token=scope();S.busy=true;S.error='';render();
 try{
  const proposal=(await send('propose_pip_update',{pip_id:pip.id,expected_version:pip.current_version,changes,reason:'Changed in the Pips view.'})).proposal;
  if(token!==scope())return false;
  if(!record(proposal)||proposal.pip_id!==pip.id||!record(proposal.definition)||!same(proposal.definition))throw Error('The saved change differs from your choice. Refresh and try again.');
  const accepted=await send('accept_pip_update',{pip_id:pip.id,proposal_id:proposal.id,expected_version:pip.current_version});
  if(token!==scope())return false;S.notice=notice+keepRunningTold(accepted);await refresh(true);return true;
 }catch(error){if(token===scope())S.error=errorText(error);return false;}
 finally{if(token===scope()){S.busy=false;render();}}
}
function personalProposalBody(proposal){
 const plan=proposal.definition?.app_plan,web=proposal.definition?.web_plan;
 if(plan)appReadPlan(plan);
 if(web)webReadPlan(web);
 const webList=v=>v?`<ul class="web-reads">${v.reads.map(r=>`<li>${esc(webReadLabel(r))}</li>`).join('')}</ul>`:'<p class="muted">None</p>';
 const webChanged=JSON.stringify(S.pip.web_plan||null)!==JSON.stringify(web||null);
 return `<dl class="meta"><dt>Name</dt><dd>${esc(proposal.definition?.name)}</dd><dt>What it does</dt><dd>${esc(proposal.definition?.goal)}</dd><dt>Model</dt><dd>${esc(modelLabel(proposal.definition?.model_choice))}</dd><dt>Schedule</dt><dd>${esc(scheduleLabel(proposal.definition?.schedule))}</dd></dl>${JSON.stringify(S.pip.app_plan||null)!==JSON.stringify(plan||null)?`<h3>Reads now</h3>${readList(S.pip.app_plan)}<h3>Reads after this change</h3>${readList(plan)}<p class="muted">This lets it read only. What it reads goes to ${esc(modelLabel(proposal.definition?.model_choice)==='Same as DGC'?'its model':modelLabel(proposal.definition?.model_choice))}. Removing access stops future reads; what it already read can’t be taken back.</p>`:''}${webChanged?`<h3>Current web reads</h3>${webList(S.pip.web_plan)}<h3>Proposed web reads</h3>${webList(web)}<p class="muted">DGC reads exactly these public pages and searches before each run.${S.pip.computer_plan||proposal.definition?.computer_plan?'':' Without a computer, it can’t open other pages, follow links, sign in or fill in forms.'}</p>`:''}<p>${esc(proposal.reason)}</p>`;
}
function readList(plan){const words=appReadWords(plan);return words.length?`<ul class="web-reads">${words.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>`:'<p class="muted">None</p>';}
function proposalReview(id,reject=false) {
  const proposal=S.pip?.proposals?.find(p=>p.id===id);if(!proposal)return;
  const stale=proposal.expected_version!==S.pip.current_version;
  // Two changes written for the same version: accepting one sets the other aside (the registry marks it
  // superseded). Say so before, so the other one does not seem to have been approved with it.
  const others=reject||stale?[]:(S.pip.proposals||[]).filter(p=>p.id!==proposal.id&&(p.approval_status||'pending')==='pending'&&p.expected_version===proposal.expected_version);
  let sourceUnsupported=false;try{sourceUnsupported=sourcePolicy(proposal.definition?.source_policy).mode==='current_tree'&&S.apiVersion<11;}catch{sourceUnsupported=true;}
  const pathTrigger=record(proposal.definition?.event_trigger)&&(Object.hasOwn(proposal.definition.event_trigger,'commit_paths')||proposal.definition.event_trigger.events?.includes('committed_paths_changed'));let pathUnsupported=pathTrigger&&S.apiVersion<22;try{if(pathTrigger)eventTrigger(proposal.definition.event_trigger);}catch{pathUnsupported=true;}
  const sessionTrigger=Array.isArray(proposal.definition?.event_trigger?.events)&&proposal.definition.event_trigger.events.includes('session_turn_completed'),sessionUnsupported=sessionTrigger&&S.apiVersion<18;
  const quillAutomation=(documentationPip(S.pip)||documentationPip(proposal.definition))&&!!(proposal.definition?.schedule||proposal.definition?.event_trigger),quillUnsupported=quillAutomation&&S.apiVersion<20;
  const pulseChange=Object.hasOwn(proposal.definition||{},'verification_plan')||Object.hasOwn(proposal.definition||{},'live_plan')||pulsePip(S.pip)&&(S.pip.verification_plan!=null||S.pip.live_plan!=null||!!proposal.definition?.schedule);let pulseUnsupported=pulseChange&&S.apiVersion<21;try{pulsePlan(proposal.definition?.verification_plan);livePlan(proposal.definition?.live_plan);}catch{pulseUnsupported=true;}
  const unavailable=(!reject&&(sourceUnsupported||sessionUnsupported||pathUnsupported||quillUnsupported||pulseUnsupported))||proposal.approval_status&&proposal.approval_status!=='pending';
  const currentSchedule=S.pip.event_trigger?'No time schedule':scheduleLabel(S.pip.schedule),proposedSchedule=proposal.definition?.event_trigger?'No time schedule':scheduleLabel(proposal.definition?.schedule);
  openReview({title:reject?'Turn this down?':`Change ${S.pip.name}?`,description:reject?`${S.pip.name} stays as it is.`:'Here’s what changes. Work already started isn’t affected.',body:personalPip()?personalProposalBody(proposal):pulseChange?pulseProposalBody(proposal,{stale,unavailable,pulseUnsupported,reject}):pathTrigger||S.pip.event_trigger?.commit_paths?pathProposalBody(proposal,{stale,unavailable,pathUnsupported,reject}):`<dl class="meta"><dt>Name</dt><dd>${esc(proposal.definition?.name)}</dd><dt>Branch or commit</dt><dd>${esc(proposal.definition?.source_ref)}</dd><dt>Model now</dt><dd>${esc(modelLabel(S.pip.model_choice))}</dd><dt>Model after</dt><dd>${esc(modelLabel(proposal.definition?.model_choice))}</dd><dt>Asked</dt><dd>${proposal.actor?esc(requester(proposal.actor)):'Not recorded'}</dd><dt>Expires</dt><dd>${proposal.expires_at?esc(date(proposal.expires_at)):'Not recorded'}</dd></dl><h3>What it would do</h3><p class="goal">${esc(proposal.definition?.goal)}</p><h3>Source</h3><dl class="meta"><dt>Now</dt><dd>${esc(sourcePolicyLabel(S.pip.source_policy))}</dd><dt>After</dt><dd>${esc(sourcePolicyLabel(proposal.definition?.source_policy))}</dd></dl><p class="muted">With your current files, it copies your saved files each time you ask (skipping files that may hold secrets); that isn’t a commit. It then runs only when you ask, with no handoffs. Changing this turns off its schedule and triggers, and switching back doesn’t bring them back.</p><h3>Changes it may make to itself</h3><dl class="meta"><dt>Now</dt><dd>${esc(adaptationLabel(S.pip.adaptation_policy))}</dd><dt>After</dt><dd>${esc(adaptationLabel(proposal.definition?.adaptation_policy))}</dd></dl><p class="muted">If it may move to a newer commit, later runs read that commit. It can never change its goal, model, schedule, triggers or permissions, or this setting. Accepting this alone runs nothing.</p>${pulseChange?`<h3>Commands now</h3>${pulsePlanReview(S.pip.verification_plan)}<h3>Commands after</h3>${pulsePlanReview(proposal.definition?.verification_plan)}`:''}<h3>Schedule</h3><dl class="meta"><dt>Now</dt><dd>${esc(currentSchedule)}</dd><dt>After</dt><dd>${esc(proposedSchedule)}</dd></dl><h3>Events</h3><dl class="meta"><dt>Now</dt><dd>${esc(eventTriggerLabel(S.pip.event_trigger))}</dd><dt>After</dt><dd>${esc(eventTriggerLabel(proposal.definition?.event_trigger))}</dd></dl>${commitRulesMarkup(S.pip.event_trigger?.commit_paths,'Paths it watches now')}${commitRulesMarkup(proposal.definition?.event_trigger?.commit_paths,'Paths it would watch')}${pathTrigger?`<p class="notice">Any other event you ticked can also start it, even without a path change. The minimum gap applies to all of them.</p><p class="muted">${esc(commitPathNotice)}</p>`:''}${quillAutomation?`<p class="notice">${esc(quillAutomationNotice)}</p>`:''}${sessionTrigger?`<p class="muted">${esc(sessionTurnNotice)}</p>`:''}<p class="muted">It runs on a schedule or on events, not both. Accepting doesn’t replay past events; if several happen while Pips are off, an active Pip runs once, and a paused or busy one skips them. ${documentationPip(S.pip)?'Events start private drafts.':'Events start read-only audits.'} They never start handoffs, fixes or tests.</p><p class="muted">A schedule runs while this Pip is active and Pips are running. If Pips were off, it runs once for the times it missed. A paused or busy Pip skips a scheduled time and picks up at the next one. When clocks change, a missing time is skipped and a repeated one runs once. What it may use doesn’t change.</p><p class="muted">${esc(proposal.reason)}</p><details><summary>Full setup (JSON)</summary><pre>${esc(JSON.stringify(proposal.definition,null,2))}</pre></details>${!reject&&stale?'<p class="notice error">This was written for an older version of this Pip. Turn it down and ask again.</p>':''}${pulseUnsupported?'<p class="notice error">This command plan can’t be accepted here. Update DGC, then refresh.</p>':''}${quillUnsupported?'<p class="notice error">Update DGC to accept a Quill schedule or events.</p>':''}${pathUnsupported?'<p class="notice error">These paths can’t be accepted here. Update DGC, then refresh.</p>':''}${sessionUnsupported?'<p class="notice error">Update DGC to accept a chat-turn trigger.</p>':''}${sourceUnsupported?'<p class="notice error">Update DGC to accept this source change.</p>':''}${unavailable?'<p class="notice error">This was already answered or is no longer available. Refresh to see it.</p>':''}${proposal.expires_at&&Date.parse(proposal.expires_at)<=Date.now()?'<p class="notice error">This expired. Ask again for a new one.</p>':''}`,confirm:reject?'Turn down':'Accept',requiresCommitPaths:!reject&&pathTrigger,requiresPulsePlan:!reject&&pulseChange,requiresQuillAutomation:!reject&&quillAutomation,requiresSessionTurn:!reject&&sessionTrigger,blocked:unavailable||(!reject&&stale),expiresAt:proposal.expires_at,request:{type:reject?'reject_pip_update':'accept_pip_update',pip_id:S.selected,proposal_id:proposal.id,expected_version:proposal.expected_version}});
  // GitHub reads are shown whichever body variant reviewed the rest; a plan this view cannot read blocks acceptance.
  // A Personal Pip's computer is shown whenever the proposal keeps, gives or removes one.
  if(S.review&&personalPip()&&(S.pip?.computer_plan||proposal.definition?.computer_plan)){const label=v=>v?'Its own browser, Terminal and files. Anything it would submit waits for your OK.':'None';S.review.body+=`<dl class="meta"><dt>Computer now</dt><dd>${label(S.pip.computer_plan)}</dd><dt>Computer after</dt><dd>${label(proposal.definition?.computer_plan)}</dd></dl>`;renderReview();}
  if(S.review&&others.length){S.review.setsAside=others.length;S.review.body+=`<p class="notice">${others.length===1?'Another change for this Pip is waiting too. It was written for the same version, so accepting this one sets that one aside. It is not approved. Ask the Pip again if you still want it.':`${others.length} other changes for this Pip are waiting too. They were written for the same version, so accepting this one sets them aside. They are not approved. Ask the Pip again if you still want them.`}</p>`;renderReview();}
  if(S.review&&!personalPip()&&(S.pip?.github_plan||proposal.definition?.github_plan)){let section;try{if(proposal.definition?.github_plan)githubReadPlan(proposal.definition.github_plan);section=githubProposalMarkup(proposal);}catch{section='<p class="notice">These GitHub reads are not supported by this view. Update DGC before accepting.</p>';if(!reject)S.review.blocked=true;}S.review.body+=section;renderReview();}
}
function updateDraft(event) {
  if(event.target.id==='pip-search'){draft.pipSearch=event.target.value;searchPips(event.target.value);return;}
  if(event.target.dataset?.cardEdit!==undefined){const e=cardEdits.get(event.target.dataset.cardEdit);if(e&&event.target.dataset.cardField in e.values)e.values[event.target.dataset.cardField]=event.target.value;return;}
  if(event.target.dataset?.commitRule!==undefined){const row=commitRules[Number(event.target.dataset.commitRule)];if(row){if(event.target.dataset.commitKind!==undefined)row.kind=event.target.value;else row.path=event.target.value;S.scheduleDirty=true;}return;}
  if(event.target.dataset?.pulseCommand!==undefined){const i=Number(event.target.dataset.pulseCommand),row=pulseCommands[i];if(row){if(event.target.dataset.pulseArg!==undefined)row.argv[Number(event.target.dataset.pulseArg)]=event.target.value;else row.cwd=event.target.value;S.scheduleDirty=true;}return;}
  const key=event.target.dataset?.draft;if(!(key in draft))return;draft[key]=event.target.type==='checkbox'?event.target.checked:event.target.value;
  if(key==='noteAdd'){const add=document.querySelector('#note-add-form button[type=submit]');if(add)add.disabled=notesBusy||!usable()||!draft.noteAdd.trim();}
  if(key==='outcomeSession'){outcomeInspectSeq++;outcomeInspection=null;outcomeInspecting=false;outcomeSessionsError='';}
  if(key==='chatText'&&S.selected){chatDrafts.set(S.selected,draft.chatText);rememberView();fitChatInput();
    // The box emptied or got its first word: voice mode and Send trade places (the caret is kept across the redraw).
    if(voiceMode&&!!$('chat-voicemode')===!!draft.chatText.trim()){const at=event.target.selectionStart;render();const box=$('chatText');if(box){box.focus();box.setSelectionRange(at,at);}}}if(key==='chatModelSearch')render();
  if(key==='sourceMode'||key==='sourceReason'||key==='sourceExcludeInput')S.sourceDirty=true;
  if(key==='pipModel')S.modelDirty=true;
  if((key==='pipPageName'||key==='pipPageTitle')&&!pageNameDirty){pageNameDirty=true;render();}
  if(key==='routineKind'&&event.type==='change')render();
  if(key.startsWith('schedule')||key.startsWith('trigger')||key==='verificationEnabled'||key==='pulseMode'||key==='liveCommands')S.scheduleDirty=true;
  if(key==='pulseMode'&&event.type==='change')render();
  if((key==='triggerPaths'||key==='triggerCommit')&&event.type==='change')render();
  if(key==='verificationEnabled'&&event.type==='change'){if(!draft.verificationEnabled)draft.scheduleType='manual';render();}
  if(key.startsWith('adaptation'))S.adaptationDirty=true;
  if(key.startsWith('quick')){S.quickDirty=true;if(key==='quickKind'&&event.type==='change')render();}
  if((key==='scheduleType'||key==='handoffTarget'||key==='adaptationMode'||key==='sourceMode'||key==='outcomeSession'||key==='outcomeSourceKind')&&event.type==='change'){render();if(key==='handoffTarget'&&executionPip(S.jobs.find(p=>p.id===draft.handoffTarget)))void loadExecution();}
}
// The chat box's undo keys and typing, for its history. The box is redrawn, so the page listens, for the box.
for(const type of ['keydown','beforeinput','input','compositionstart','compositionend'])document.addEventListener(type,event=>{if(chatHistory&&event.target?.id==='chatText')chatHistory[type](event);});
document.addEventListener('input',updateDraft);
document.addEventListener('paste',event=>{if(event.target?.id!=='chatText'||!canAttachImages())return;const files=[...(event.clipboardData?.files||[])];if(!files.length)return;event.preventDefault();addImageFiles(files);});
document.addEventListener('dragover',event=>{if(canAttachImages()&&event.target?.closest?.('#chat-form')&&[...(event.dataTransfer?.types||[])].includes('Files'))event.preventDefault();});
document.addEventListener('drop',event=>{if(!canAttachImages()||!event.target?.closest?.('#chat-form'))return;const files=[...(event.dataTransfer?.files||[])];if(!files.length)return;event.preventDefault();addImageFiles(files);});
document.addEventListener('change',event=>{if(event.target.dataset?.pluginLevel){const t=event.target,level=t.value,label=(PLUGIN_LEVELS.find(l=>l[0]===level)||[])[1]||level;void pipsSettingsCall('set_plugin_permission',{plugin:t.dataset.pluginLevel,level},`Saved. ${t.dataset.pluginName||'This plugin'}: ${label.toLowerCase()}.`);return;}if(event.target.id==='chat-attach-input'){addImageFiles(event.target.files||[]);event.target.value='';return;}if(event.target.id==='keep-running'){void setKeepRunning(event.target.checked);return;}if(event.target.id==='desktop-notifications'){void setDesktopNotifications(event.target.checked);return;}if(event.target.id==='pipEyes'){void setEyes(event.target.value);return;}if(event.target.id==='pipLevel'){void setLevel(event.target.value);return;}if(event.target.dataset?.loginAll){const l=(loginsState.value||[]).find(x=>x.id===event.target.dataset.loginAll),all=event.target.checked;if(l)void loginCall('grant_pip_login',{login_id:l.id,pips:all?'all':[S.selected]},all?`All your Pips can use the login for ${l.site}.`:`Only ${S.pip?.name||'this Pip'} uses the login for ${l.site} now.`);return;}if(event.target.id==='pipCareful'){const on=event.target.checked;void carefulCall('set_pip_careful',{on},on?'Careful mode is on.':'Careful mode is off. Its submits still wait for you.');return;}if(event.target.id==='pipNotify'){const on=event.target.checked;void setProfile({notify:on},on?'It tells you when it finishes something on its own or needs you.':'It won’t notify you. Its chat still has everything.');return;}if(event.target.dataset?.routineToggle){const id=event.target.dataset.routineToggle,on=event.target.checked;void routineCall('update_pip_routine',{routine_id:id,changes:{status:on?'on':'off'}},id,on?'Routine on.':'Routine off. It won’t run until you turn it on.');return;}if(event.target.id==='chat-context'){updateChatPreference('context_size',event.target.value);return;}if(event.target.id==='chat-thinking'){updateChatPreference('thinking',chatThinkingLevels[Number(event.target.value)]);return;}if(event.target.id==='commandReceiptSession'){commandDetailSeq++;commandSeq++;commandLoading=false;commandSession=event.target.value;commandReceipts=[];commandLoaded=false;commandCursor=null;commandMore=false;void loadCommandReceipts();return;}updateDraft(event);});
document.addEventListener('submit',event=>{
  if(event.target.id==='login-form'){event.preventDefault();void saveLogin();return;}
  if(event.target.id==='computer-go'){event.preventDefault();const url=$('computer-url').value.trim();if(url)void computerView('go',{url:/^https?:\/\//i.test(url)?url:'https://'+url});return;}
  if(event.target.id==='computer-type'){event.preventDefault();const input=$('computer-text'),text=input.value;if(text){input.value='';void computerView('type',{text});}return;}
  const id=event.target.id;if(!['note-add-form','working-notes-form','create-form','revision-form','context-form','schedule-form','chat-form','model-form','handoff-form','adaptation-form','source-form','outcome-form','pip-statement-form','web-reads-form','notify-form','github-form','quick-schedule-form','pip-name-form','pip-instructions-form','routine-form'].includes(id))return;event.preventDefault();
  if(!usable()||S.busy||!S.workspace)return;if(archived()&&['revision-form','schedule-form','chat-form','model-form','handoff-form','adaptation-form','source-form','pip-statement-form','web-reads-form','quick-schedule-form'].includes(id)){setError(`${S.pip?.name||'This Pip'} is archived. Restore it in Settings first.`);return;}
  if(id==='pip-statement-form'){void reviewStatement();return;}
  if(id==='quick-schedule-form'){
    let schedule;try{schedule=quickSchedule();}catch(error){setError(error);return;}
    void applyOwnChange(S.apiVersion>=10?{schedule,event_trigger:null}:{schedule},d=>JSON.stringify(d.schedule??null)===JSON.stringify(schedule),schedule?`Saved. It runs ${scheduleLabel(schedule).replace(/^Daily/,'every day').replace(/^Weekdays/,'on weekdays').replace(/^Every/,'every')}.`:'Saved. It runs when you ask it to.').then(ok=>{if(ok){S.quickDirty=false;S.scheduleDirty=false;}});return;
  }
  if(id==='outcome-form'){
    try{if(S.apiVersion<12||!outcomeInspection||outcomeInspection.id!==draft.outcomeSession)throw Error('Choose a session and check it first.');const title=draft.outcomeTitle.trim(),statement=draft.outcomeText.trim();if(!title||!statement||new TextEncoder().encode(title).length>240||new TextEncoder().encode(statement).length>1536)throw Error('Add a short title and a statement of a paragraph or two. Nothing is shortened for you.');const source=sessionSourceSelection(draft.outcomeSourceKind==='commit'?{kind:'commit',revision:draft.outcomeSourceValue.trim()}:{kind:'pip_run',run_id:draft.outcomeSourceValue.trim()});
      const request={type:'propose_workspace_session_outcome',workspace_id:S.workspace.id,session_id:outcomeInspection.id,title,statement,source,expected_session_revision:outcomeInspection.revision},signature=JSON.stringify(request);if(outcomeRetry?.signature!==signature)outcomeRetry={signature,key:'editor-statement-'+globalThis.crypto.randomUUID()};
      void mutate({...request,request_key:outcomeRetry.key},answer=>{if(answer.workspace_id!==S.workspace.id)throw Error('The saved statement belongs to another workspace.');const p=sessionStatement(answer.proposal,S.workspace.id);if(p.title!==title||p.statement!==statement||p.session.id!==request.session_id||p.session.revision!==request.expected_session_revision||p.session.sha256!==outcomeInspection.sha256||p.session.bytes!==outcomeInspection.bytes||JSON.stringify(p.source_reference.selection)!==JSON.stringify(source))throw Error('The saved statement doesn’t match what you wrote. Refresh and try again.');outcomeHistory=[p,...outcomeHistory.filter(old=>old.id!==p.id)].slice(0,100);outcomeLoaded=true;S.notice='Statement saved. It’s added to context only when you accept it.';reviewOutcome(p);});
    }catch(error){setError(error);}return;
  }
  if(id==='chat-form'){void sendChat();return;}
  if(id==='handoff-form'){
    const saved=S.handoffDraft,target=S.jobs.find(p=>p.id===draft.handoffTarget&&p.id!==S.selected);
    if(saved?.personal){submitPersonalHandoff(saved,target);return;}
    if(archived()||!saved||!target||target.status==='archived'||!committedJob(target)||documentationPip(target)||!pipType(target,S.types)?.available||(saved.artifact&&target.pip_type!=='pulse')){setError('Choose a Pip in this project to hand it to.');return;}
    let action;try{action=handoffAction(target.pip_type==='patch'?'patch':target.pip_type==='pulse'?'test':'read_only',draft.handoffPaths,draft.handoffTests,target.pip_type==='patch'?specialistDraft():undefined);}catch(error){setError(error);return;}
    const handoffScope=scope(),task=draft.handoffTask.trim();if(!task||new TextEncoder().encode(task).length>4000){setError('Say what it should do, in a paragraph or two.');return;}
    const request={type:saved.artifact?'propose_pip_artifact_handoff':'propose_pip_handoff',source_run_id:saved.runId,...(saved.artifact?{}:{finding_index:saved.index}),target_pip_id:target.id,task,action},signature=JSON.stringify(request);
    if(saved.signature!==signature){saved.signature=signature;saved.key='editor-handoff-'+globalThis.crypto.randomUUID();}
    void mutate({...request,idempotency_key:saved.key},async result=>{const h=handoffRecord(result.handoff,S.selected,S.workspace.id);if(h.source_run_id!==saved.runId||(saved.artifact?(h.payload.type!=='patch_artifact.v1'||h.payload.source.artifact.sha256!==saved.artifact.artifact.sha256||h.payload.source.result_digest!==saved.artifact.result_digest||h.payload.source.review_revision!==saved.artifact.review_revision):h.payload.source.finding_index!==saved.index)||h.target_pip_id!==target.id)throw new Error('The saved handoff doesn’t match what you chose. Refresh and try again.');S.handoffDraft=null;S.notice='Handoff saved. Nothing starts until you approve it.';if(h.payload.action.kind!=='read_only')await loadExecution();if(handoffScope!==scope())return;reviewHandoff(h);void loadHandoffs();});return;
  }
  if(id==='web-reads-form'){
    if(S.apiVersion<40||!personalPip()){setError('Update DGC to add web reads.');return;}
    let plan;try{plan=webReadsFromText(draft.webReads||webReadsLines(S.pip.web_plan));}catch(error){setError(error);return;}
    void mutate({type:'propose_pip_update',pip_id:S.selected,expected_version:S.pip.current_version,changes:{web_plan:plan},reason:'Review these exact web reads for this Personal Pip.'},result=>{const p=result.proposal;if(!record(p)||p.pip_id!==S.selected||JSON.stringify(p.definition?.web_plan)!==JSON.stringify(plan))throw new Error('The saved web reads differ from this review. Refresh before accepting.');draft.webReads='';S.pip={...S.pip,proposals:[...(S.pip.proposals||[]).filter(v=>v.id!==p.id),p]};proposalReview(p.id);});
    return;
  }
  if(id==='source-form'){
    if(S.apiVersion<11||!['scout','lens','rook','lock','quill'].includes(S.pip?.pip_type??'rook')){setError('Update DGC to change what this Pip reads.');return;}
    if(S.apiVersion>=50&&!addSourceExclude()){render();return;}
    let policy;try{policy=S.apiVersion>=50?draftSourcePolicy():sourcePolicy(draft.sourceMode==='current_tree'?{mode:'current_tree',exclusions:'safe_source_v1'}:{mode:draft.sourceMode});}catch(error){setError(error);return;}
    if(S.sourceDraftVersion!==S.pip.current_version){setError('The Pip changed while you edited this. Reset it and choose again.');return;}
    // Before API 50 every source save also cleared the schedule; now only a switch to current files does.
    const clears=S.apiVersion<50||policy.mode==='current_tree',changes=clears?{source_policy:policy,schedule:null,event_trigger:null}:{source_policy:policy};
    void applyOwnChange(changes,d=>JSON.stringify(sourcePolicy(d.source_policy))===JSON.stringify(policy)&&(!clears||d.schedule===null&&d.event_trigger===null),clears?'Source saved. Its schedule was turned off; set one again if you want it.':'Source saved. Its next run uses it.').then(ok=>{if(ok){S.sourceDirty=false;sourceCheckState={pip:'',value:null,loading:false,error:''};}});return;
  }
  if(id==='github-form'){
    if(S.apiVersion<41||!githubPip()){setError('Update DGC to add GitHub reads. They work for Scout, Lens, Rook, Lock and Quill.');return;}
    let plan;try{plan=githubPlanFromDraft();}catch{setError('Name the repository as owner/name, choose at least one read, and use up to five labels without commas.');return;}
    void mutate({type:'propose_pip_update',pip_id:S.selected,expected_version:S.pip.current_version,changes:{github_plan:plan},reason:'GitHub reads chosen in Settings.'},result=>{const p=result.proposal;if(!record(p)||p.pip_id!==S.selected||JSON.stringify(p.definition?.github_plan)!==JSON.stringify(plan))throw new Error('The saved GitHub reads differ from this review. Refresh before accepting.');S.pip={...S.pip,proposals:[...(S.pip.proposals||[]).filter(v=>v.id!==p.id),p]};proposalReview(p.id);});
    return;
  }
  if(id==='notify-form'){
    const n=notifyState.value,pip=S.selected;if(S.apiVersion<41||!n||n.pip_id!==pip)return;
    const min=draft.notifyMin,alert=draft.notifyAlert==='off'?null:draft.notifyAlert;
    if(!SEVERITIES.includes(min)||alert!==null&&SEVERITIES.indexOf(alert)<SEVERITIES.indexOf(min)){notifyState.error='Alerts must be at least as severe as the findings the digest shows.';render();return;}
    void mutate({type:'set_pip_notify_settings',pip_id:pip,min_severity:min,alert_severity:alert,expected_revision:n.revision},result=>{const value=pipNotifySettings(result.settings,pip);if(value.min_severity!==min||value.alert_severity!==alert)throw Error('The saved settings differ from your choice. Refresh and try again.');notifyState={pip,value,loading:false,error:''};S.notice='Notifications saved. Nothing else changed.';});
    return;
  }
  if(id==='adaptation-form'){
    if(S.apiVersion<10){setError('Update DGC to change this.');return;}
    let policy;try{policy=adaptationPolicy({mode:draft.adaptationMode,allowed_fields:draft.adaptationMode==='bounded_adaptive'?[...(draft.adaptationName?['name']:[]),...(draft.adaptationSource?['source_ref']:[])]:draft.adaptationMode==='autonomous'?['name','source_ref']:[]});}catch(error){setError(error);return;}
    if(S.adaptationDraftVersion!==S.pip.current_version){setError('The Pip changed while you edited this. Reset it and choose again.');return;}
    void applyOwnChange({adaptation_policy:policy},d=>JSON.stringify(adaptationPolicy(d.adaptation_policy))===JSON.stringify(policy),'Saved. The Pip uses this from its next run.').then(ok=>{if(ok)S.adaptationDirty=false;});return;
  }
  if(id==='model-form'){
    let choice;try{choice=modelChoice(draft.pipModel,S.models,subscriptionChoices(personalPip()));}catch(error){setError(error);return;}
    void applyOwnChange({model_choice:choice},d=>JSON.stringify(d.model_choice)===JSON.stringify(choice),`Model saved: ${modelLabel(choice)}. Its next run uses it.${choice.mode==='subscription'?' '+subscriptionUsage(modelLabel(choice)):''}`).then(ok=>{if(ok)S.modelDirty=false;});return;
  }
  if(id==='create-form'){
    if(S.workspace?.kind==='personal'){S.createType=$('personal-character').value;S.createStep='configure';draft.source_ref='HEAD';}
    const selectedType=S.types.find(t=>t.id===S.createType);
    if(!S.create||S.createStep!=='configure'||!selectedType?.available){setError('Choose an available Pip type first.');return;}
    if(!draft.name.trim()||!draft.goal.trim()||!draft.source_ref.trim()){setError('Give it a name, say what it does, and choose a branch or commit.');return;}
    let choice;try{choice=modelChoice(draft.createModel,S.models,subscriptionChoices(S.workspace?.kind==='personal'));}catch(error){setError(error);return;}
    const request={type:'create_pip',workspace_id:S.workspace.id,pip_type:selectedType.id,model_choice:choice,name:draft.name.trim(),goal:draft.goal.trim(),source_ref:draft.source_ref.trim()};
    if(executionPip(selectedType)&&S.workspace?.kind!=='personal'){
      openReview({title:`Create ${selectedType.name}?`,description:selectedType.id==='pulse'?'You can chat with it, but it can’t run any commands yet. You approve each command it runs, in a handoff or a command plan.':'You can chat with it, but it can’t change files or run tests on its own. You approve each fix in a handoff first.',body:`<h3>${esc(request.name)}</h3><p class="goal">${esc(request.goal)}</p><dl class="meta"><dt>Branch or commit</dt><dd>${esc(request.source_ref)}</dd><dt>Model</dt><dd>${esc(modelLabel(choice))}</dd><dt>Runs</dt><dd>Only when you approve it</dd></dl><p class="muted">${selectedType.id==='patch'?'Patch can change only the exact files you approve, in a private copy.':'Pulse can run only the exact commands you approve, in a private copy.'} No network, and your files are never changed. ${selectedType.id==='pulse'?'After you create it, you can give it a command plan and a schedule.':'It doesn’t run on a schedule.'}</p><p class="muted">${seatbeltRunner()?'Each approved test gets up to 60 seconds, 30 seconds of CPU per process and 64 KB of output. On macOS, the 512 MB memory, 32-process and 64 MB scratch limits are checked every so often, not enforced exactly. Tests can’t change the code.':'Each approved test gets up to 60 seconds, 30 seconds of CPU and 512 MB of memory per process, 64 KB of output and 32 processes, with a 64 MB scratch folder. Total memory is checked every so often, not enforced exactly. Tests can’t change the code.'} You see these limits again with each command.</p>`,confirm:'Create Pip',request});
    }else void mutate(request,finishCreate);
  }else if(id==='pip-name-form'){void saveNameAndTitle();
  }else if(id==='pip-instructions-form'){
    const goal=draft.pipInstructions.trim();if(!goal){setError('Say what it is for.');return;}
    if(goal===S.pip?.goal){S.pipPage='info';render();return;}
    void applyOwnChange({goal},d=>d.goal===goal,'Saved. It works from these instructions now.').then(ok=>{if(ok){S.pipPage='info';render();}});
  }else if(id==='working-notes-form'){void saveWorkingNotes();
  }else if(id==='note-add-form'){if(draft.noteAdd.trim())void noteCall('add_pip_note',{text:draft.noteAdd.trim()},()=>{draft.noteAdd='';return 'Added. It remembers this now.';});
  }else if(id==='routine-form'){void saveRoutine();
  }else if(id==='revision-form'){
    const goal=draft.revisionGoal.trim();if(!goal){setError('Say what this Pip should do.');return;}
    void applyOwnChange({goal},d=>d.goal===goal,'Saved. Its next run works on this.').then(ok=>{if(ok){draft.revisionGoal='';S.editingGoal=false;}});
  }else if(id==='schedule-form'){
    if(currentTree()||executionPip(S.pip)&&!pulsePip(S.pip)){setError('This Pip can’t run on a schedule.');return;}
    let verification_plan,live_plan;try{if(pulsePip(S.pip)&&S.apiVersion>=60&&draft.pulseMode==='live'){live_plan=livePlanFromText(draft.liveCommands);if(draft.scheduleType==='events')throw Error('A live-data Pip runs on a schedule or when you ask, not on events.');if(S.pip.verification_plan!=null)verification_plan=null;}else if(pulsePip(S.pip)){if(S.apiVersion>=60&&S.pip.live_plan!=null)live_plan=null;if(S.apiVersion<21)throw Error('Update DGC to give Pulse a command plan.');verification_plan=draft.verificationEnabled?(S.pip.verification_plan?.action?.network==='loopback_http_v1'?pulsePlan({...S.pip.verification_plan,action:{...S.pip.verification_plan.action,tests:pulseCommands}}):pulsePlanFromCommands(pulseCommands)):null;if(draft.scheduleType==='events'||!verification_plan&&draft.scheduleType!=='manual')throw Error('To run Pulse on a schedule, tick Use a command plan. Pulse can’t run on events.');}}catch(error){setError(error);return;}
    if(documentationPip(S.pip)&&draft.scheduleType!=='manual'&&S.apiVersion<20){setError('Update DGC to schedule Quill or run it on events.');return;}
    let schedule=null,event_trigger=null;try{if(draft.scheduleType==='events'){if(S.apiVersion<10)throw new Error('Update DGC to run this Pip on events.');event_trigger=eventTriggerFromDraft(draft,commitRules);if(event_trigger.events.includes('committed_paths_changed')&&S.apiVersion<22)throw Error('Update DGC to watch paths.');if(event_trigger.events.includes('session_turn_completed')&&S.apiVersion<18)throw new Error('Update DGC to run this Pip after a chat turn.');}else schedule=scheduleFromDraft(draft);}catch(error){setError(error);return;}
    if(S.scheduleDraftVersion!==S.pip?.current_version){setError('The Pip changed while you edited its schedule. Reset it and choose again.');return;}
    const changes=pulsePip(S.pip)?{...(verification_plan!==undefined?{verification_plan}:{}),...(live_plan!==undefined?{live_plan}:{}),schedule,event_trigger:null}:S.apiVersion>=10?{schedule,event_trigger}:{schedule};
    // The full schedule form (events, cron, once, path rules, Pulse commands) shows one review of exactly
    // what will run; the quick control in Settings saves directly.
    void mutate({type:'propose_pip_update',pip_id:S.selected,expected_version:S.scheduleDraftVersion,changes,reason:'Changed in the Pips view.'},result=>{
      const proposal=result.proposal;
      if(!record(proposal)||proposal.pip_id!==S.selected||typeof proposal.id!=='string'||!record(proposal.definition))throw new Error('The change didn’t save. Refresh and try again.');
      if(verification_plan!==undefined&&!pulsePlanEqual(proposal.definition.verification_plan,verification_plan))throw Error('The saved commands don’t match what you entered. Refresh and try again.');
      if(live_plan!==undefined&&JSON.stringify(proposal.definition.live_plan??null)!==JSON.stringify(live_plan))throw Error('The saved commands don’t match what you entered. Refresh and try again.');
      if(S.apiVersion>=10&&(JSON.stringify(eventTrigger(proposal.definition.event_trigger))!==JSON.stringify(event_trigger)||JSON.stringify(proposal.definition.schedule??null)!==JSON.stringify(schedule)))throw new Error('The saved schedule doesn’t match what you chose. Refresh and try again.');
      S.pip={...S.pip,proposals:[...(S.pip.proposals||[]).filter(p=>p.id!==proposal.id),proposal]};
      S.notice='Schedule change saved. Nothing changes until you accept it; if you close this, it waits in Waiting changes.';
      proposalReview(proposal.id);
    });
  }else if(id==='context-form'){
    if(!S.context||!draft.contextTitle.trim()||!draft.contextContent.trim()){setError('Add a title and a note.');return;}
    const bytes=value=>new TextEncoder().encode(value).length;
    if(bytes(draft.contextTitle.trim())>240||bytes(draft.contextContent)>4096){setError('That’s too long. Keep the title short and the note to about 4,000 characters (fewer with emoji). Nothing was shortened.');return;}
    openReview({title:'Add to context?',description:'Every Pip in this project sees this note in runs that start from now on. It gives them no new permissions.',body:`<h3>${esc(draft.contextTitle.trim())}</h3><p class="goal">${esc(draft.contextContent)}</p>`,confirm:'Add to context',request:{type:'record_workspace_context',workspace_id:S.workspace.id,kind:draft.contextKind,title:draft.contextTitle.trim(),content:draft.contextContent,expected_revision:S.context.revision}});
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
  if(S.composerPanel&&!event.target.closest?.('.composer-model-menu,#chat-model,#chat-context-toggle')){S.composerPanel='';render();}
  if(event.target.closest?.('#chat-voicemode')){S.error='';voiceMode?.start();return;}
  const talkAction=event.target.closest?.('[data-voicebar="pips-talk"] [data-voice-action]')?.dataset.voiceAction;
  if(talkAction){voiceMode?.action(talkAction);return;}
  if(event.target.closest?.('#chat-mic')&&S.mic==='idle'){const box=$('chatText');micCaret=box?[box.selectionStart,box.selectionEnd]:null;S.error='';micShow('starting');render();vscode.postMessage({type:'micStart',from:'pips'});return;}
  const voiceAction=event.target.closest?.('[data-voice-action]')?.dataset.voiceAction;
  if(voiceAction==='cancel'){micCancel();return;}
  if((voiceAction==='stop'||voiceAction==='send')&&S.mic==='recording'){micShow('writing',voiceAction);render();vscode.postMessage({type:'micStop',mode:voiceAction==='send'?'send':'insert',from:'pips'});return;}
  const link=event.target.closest?.('.md-link');
  if(link){event.preventDefault();const target=window.DgcMarkdown?.linkTarget?.(link.dataset.target+(link.dataset.line?`:${link.dataset.line}`:''));if(target?.kind==='external')vscode.postMessage({type:'openExternal',url:target.target});else if(target?.kind==='file')vscode.postMessage({type:'openFile',path:target.target,line:target.line});return;}
  const copy=event.target.closest?.('button.copy[data-c]');if(copy){event.preventDefault();try{vscode.postMessage({type:'copy',text:decodeURIComponent(copy.dataset.c)});copy.classList.add('done');copy.title='Copied';copy.setAttribute('aria-label','Copied');copy.innerHTML=transcriptIcon('check');}catch{/* malformed generated data is not copied */}return;}
  const photo=event.target.closest?.('img[data-message-image]');
  if(photo&&S.apiVersion>=43&&!remoteHost){openMessageImage(photo.dataset.messageImage);return;}
  const target=event.target.closest('button');if(!target||target.disabled)return;
  if(target.dataset.pipsTab){chooseScopeTab(target.dataset.pipsTab);return;}
  if(target.dataset.workingNotes){if(target.dataset.workingNotes==='edit'&&S.workingNotes){workingNotesEditing=true;draft.workingNotesText=S.workingNotes.lines.join('\n');render();$('workingNotesText')?.focus();}else if(target.dataset.workingNotes==='cancel'){workingNotesEditing=false;draft.workingNotesText='';S.workingNotesError='';render();void loadWorkingNotes();}return;}
  if(target.dataset.pipLearn){const l=S.learn,a=target.dataset.pipLearn;if(a==='save')void saveLearn();else if(a==='edit'&&l?.status==='draft'){if(l.editing)l.text=draft.pipLearnText;else draft.pipLearnText=l.text;l.editing=!l.editing;render();if(l.editing)$('pipLearnText')?.focus();}else if(a==='cancel'&&l){S.learn={pip:l.pip,status:'cancelled',name:l.name};render();}else if(a==='dismiss'){S.learn=null;render();$('chatText')?.focus();}return;}
  if(target.id==='chat-attach'){$('chat-attach-input')?.click();return;}
  if(target.dataset.removeFile!==undefined){const i=Number(target.dataset.removeFile),files=[...pendingFiles()];if(Number.isInteger(i)&&i>=0&&i<files.length){files.splice(i,1);files.length?chatFiles.set(S.selected,files):chatFiles.delete(S.selected);render();$('chatText')?.focus();}return;}
  if(target.dataset.removeImage!==undefined){const i=Number(target.dataset.removeImage),images=[...pendingImages()];if(Number.isInteger(i)&&i>=0&&i<images.length){images.splice(i,1);images.length?chatImages.set(S.selected,images):chatImages.delete(S.selected);render();$('chatText')?.focus();}return;}
  if(target.dataset.newCharacter){if(SIMPLE_CHARACTERS.includes(target.dataset.newCharacter)&&target.dataset.newCharacter!=='core'){draft.newPipCharacter=target.dataset.newCharacter;if(S.review?.newPip){S.review.body=newPipBody();renderReview();}}return;}
  if(target.id==='pin-pips-sidebar'){S.sidebarPinned=!S.sidebarPinned;rememberView();render();return;}
  if(target.dataset.chatActivity){void toggleChatActivity(target.dataset.chatActivity);return;}
  if(target.dataset.chatAction){
    const m=S.messages.find(m=>m.id===target.dataset.messageId);if(!m)return;
    if(target.dataset.chatAction==='read'){reader?.toggle(m.id,m.text);return;}
    if(target.dataset.chatAction==='copy'){vscode.postMessage({type:'copy',text:m.text});target.innerHTML=transcriptIcon('check')+'<span class="sr-only">Copied</span>';target.title='Copied';target.setAttribute('aria-label','Copied');const status=target.parentElement.querySelector('.copy-feedback');if(status)status.textContent='Copied';return;}
    const prompt=S.messages.find(p=>p.role==='user'&&p.run_id===m.run_id);if(!prompt||archived()||!usable())return;
    if(draft.chatText.trim()&&draft.chatText!==prompt.text){S.notice='You have an unsent message in the box. Send or copy it first, then edit this one.';render();return;}
    chatEdit(()=>{draft.chatText=prompt.text;chatDrafts.set(S.selected,draft.chatText);rememberView();render();});$('chatText')?.focus();
    if(target.dataset.chatAction==='retry')void sendChat();
    return;
  }
  if(target.dataset.removeSourceExclude!==undefined){if(S.busy||archived())return;const i=Number(target.dataset.removeSourceExclude);if(Number.isInteger(i)&&i>=0&&i<sourceExcludeList.length){sourceExcludeList.splice(i,1);S.sourceDirty=true;sourceExcludeProblem='';render();}return;}
  if(target.id==='add-source-exclude'){if(S.busy||archived())return;addSourceExclude();render();$('sourceExcludeInput')?.focus();return;}
  if(target.id==='check-source'){void checkSource();return;}
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
  if(target.dataset.loginCard){const a=computerState.pip===S.selected?computerState.value?.actions?.find(x=>x.id===target.dataset.loginCard):null;if(a)openLoginForm(a);return;}
  if(target.dataset.loginNew!==undefined){openLoginForm(null);return;}
  if(target.dataset.loginAskRemove){loginsState.confirm=target.dataset.loginAskRemove;render();return;}
  if(target.dataset.loginKeep!==undefined){loginsState.confirm='';render();return;}
  if(target.dataset.loginRemove){const l=(loginsState.value||[]).find(x=>x.id===target.dataset.loginRemove);void loginCall('remove_pip_login',{login_id:target.dataset.loginRemove},`Removed. No Pip signs in to ${l?.site||'that site'} with it now.`);return;}
  if(target.dataset.loginShare){const l=(loginsState.value||[]).find(x=>x.id===target.dataset.loginShare);if(l&&l.pips!=='all')void loginCall('grant_pip_login',{login_id:l.id,pips:[...l.pips,S.selected]},`${S.pip?.name||'It'} can use the login for ${l.site} now.`);return;}
  if(target.dataset.computerDecide){void decideInChat(target.dataset.computerDecide,target.dataset.approve==='1');return;}
  if(target.dataset.cardOpen){cardRefused='';if(computerState.pip===S.selected&&computerState.value?.granted)void openComputerView();render();return;}
  if(target.dataset.cardDismiss){cardRefused='';render();return;}
  if(target.dataset.revokeGrant){revokeGrant(target.dataset.revokeGrant);return;}
  if(target.dataset.routineAdd){const id=target.dataset.routineAdd;void routineCall('decide_pip_routine',{routine_id:id,add:true},id,'Routine added. It runs on its own now.');return;}
  if(target.dataset.routineDecline){const id=target.dataset.routineDecline;void routineCall('decide_pip_routine',{routine_id:id,add:false},id,'');return;}
  if(target.dataset.routineEdit){editRoutine(target.dataset.routineEdit);return;}
  if(target.dataset.routineNew!==undefined){editRoutine('new');return;}
  if(target.dataset.routineCancel!==undefined){routineEditing='';routineError='';render();return;}
  if(target.dataset.routineDelete){const id=target.dataset.routineDelete;void routineCall('delete_pip_routine',{routine_id:id},id,'Routine deleted.').then(r=>{if(r){routineEditing='';render();}});return;}
  if(target.dataset.routineLegacy!==undefined){S.legacyOpen=!S.legacyOpen;render();return;}
  if(target.dataset.pipPage){const v=target.dataset.pipPage;if(v==='instructions')draft.pipInstructions=S.pip?.goal||'';if(v==='character'){const look=profile(S.pip?.profile);draft.lookBody=look.body||'';draft.lookColor=look.color||'';lookDirty=false;}S.pipPage=v;render();if(v==='instructions')$('pipInstructions')?.focus();if(v==='info')void loadRoutines();return;}
  if(target.dataset.pipPageTab){S.pipPage=target.dataset.pipPageTab;routineEditing='';render();if(S.pipPage==='info')void loadRoutines();else void loadShared(S.pipPage);return;}
  if(target.dataset.pipShare!==undefined){document.querySelectorAll('details[data-details="pip-menu"]').forEach(d=>d.removeAttribute('open'));void exportPipFile();return;}
  if(target.dataset.pipBody){if(BODIES.includes(target.dataset.pipBody)){draft.lookBody=target.dataset.pipBody;lookDirty=true;render();}return;}
  if(target.dataset.pipColor!==undefined){const c=target.dataset.pipColor;if(c===''||COLORS.some(x=>x[0]===c)){draft.lookColor=c;lookDirty=true;render();}return;}
  if(target.dataset.pipCharacterReset!==undefined){draft.lookBody='';draft.lookColor='';lookDirty=true;render();return;}
  if(target.dataset.pipCharacterSave!==undefined){const own=S.pip?.pip_type,body=draft.lookBody&&draft.lookBody!==own?draft.lookBody:null;void setProfile({body,color:draft.lookColor||null},'Saved. That’s its face now.').then(ok=>{if(ok){lookDirty=false;S.pipPage='info';render();}});return;}
  if(target.dataset.pipNameCancel!==undefined){draft.pipPageName=S.pip?.name||'';draft.pipPageTitle=profile(S.pip?.profile).title;pageNameDirty=false;render();return;}
  if(target.dataset.openLink){vscode.postMessage({type:'openExternal',url:target.dataset.openLink});return;}
  if(target.dataset.openComputerFiles!==undefined){if(computerState.pip===S.selected&&computerState.value?.granted)void openComputerView();return;}
  if(target.dataset.setupChat!==undefined){S.tab='chat';chatEdit(()=>{draft.chatText='Change your instructions: ';chatDrafts.set(S.selected,draft.chatText);rememberView();render();});void loadMessages();$('chatText')?.focus();return;}
  if(target.dataset.copyPipId!==undefined){document.querySelectorAll('details[data-details="pip-menu"]').forEach(d=>d.removeAttribute('open'));vscode.postMessage({type:'copy',text:S.selected});S.notice='Copied its ID.';render();return;}
  if(target.dataset.pipsSettings){pipsSettings.view=target.dataset.pipsSettings;render();void loadPipsSettings();return;}
  if(target.dataset.computersUpdate!==undefined){void pipsSettingsCall('update_pip_computers',{},r=>r?.started?'Checking for updates. This can take a few minutes.':'Already checking for updates.');return;}
  if(target.dataset.computerResetAsk){pipsSettings.confirmReset=target.dataset.computerResetAsk;render();return;}
  if(target.dataset.computerResetCancel!==undefined){pipsSettings.confirmReset='';render();return;}
  if(target.dataset.computerReset){void pipsSettingsCall('reset_pip_computer',{pip_id:target.dataset.computerReset},r=>r?.reset?'Its computer is fresh: signed out, no history. Its Files are still there.':'Resetting its computer: it is fresh the next time it opens. Its Files stay.');return;}
  if(target.dataset.appRemove){void pipsSettingsCall('disconnect_pip_app_link',{pip_id:target.dataset.appRemovePip,link_id:target.dataset.appRemove},'Removed. That Pip no longer uses the account.');return;}
  if(target.dataset.attention){const item=S.attention?.items.find(i=>i.id===target.dataset.attention);if(item)void navigateFromHost(attentionNavigation(item)).catch(setError);return;}
  if(target.dataset.eyesSwitch){const model=target.dataset.eyesSwitch,choice={mode:'model',model};void applyOwnChange({model_choice:choice},d=>JSON.stringify(d.model_choice)===JSON.stringify(choice),`${S.pip.name} now uses ${model}, which can see.`).then(ok=>{if(ok)void loadEyes();});return;}
  if(target.dataset.levelAsk!==undefined){void setLevel('ask');return;}
  if(target.dataset.siteForget){void carefulCall('forget_pip_site',{site:target.dataset.siteForget},`Removed. It asks before it opens ${target.dataset.siteForget} again.`);return;}
  if(target.dataset.sitesAll){sitesAll=true;render();return;}
  if(target.dataset.noteForget){const n=(S.notes||[]).find(x=>x.id===target.dataset.noteForget);void noteCall('forget_pip_note',{note_id:target.dataset.noteForget},()=>n?`Forgotten: ${n.text}`:'Forgotten.');return;}
  if(target.dataset.noteForgetAll){if(target.dataset.noteForgetAll==='ask'){noteConfirmAll=true;render();}else if(target.dataset.noteForgetAll==='no'){noteConfirmAll=false;render();}else void noteCall('forget_pip_note',{all:true},()=>{noteConfirmAll=false;return 'Forgotten. It remembers nothing about you now.';});return;}
  if(target.dataset.attentionMore!==undefined){attentionExpanded=target.dataset.attentionMore==='1';render();return;}
  if(target.dataset.pluginUseRemove){void pipsSettingsCall('decline_pip_plugin',{pip_id:target.dataset.pluginUsePip,grant_id:target.dataset.pluginUseRemove},'Removed. That Pip no longer uses the plugin.');return;}
  if(target.dataset.openPlugins!==undefined){vscode.postMessage({type:'openSettings',section:'plugins'});return;}
  if(target.dataset.job){if(event.detail>0&&!S.sidebarPinned)shell.classList.add('sidebar-dismissed');void select(target.dataset.job);return;}
  if(target.dataset.postOpen){openPostReport(target.dataset.postOpen);return;}
  if(target.dataset.postFix){askDgcAbout(target.dataset.postFix);return;}
  if(target.dataset.postRun){if(canRunNow())runNow();return;}
  if(target.dataset.postMore){const key=target.dataset.postMore;if(!shownInFull.delete(key))shownInFull.add(key);render();return;}
  if(target.dataset.lastPost){jumpToPost(target.dataset.lastPost);return;}
  if(target.dataset.chatRun){S.tab='runs';S.overview=false;render();void loadRun(target.dataset.chatRun);return;}
  if(target.dataset.lastRun){S.tab='runs';S.overview=false;render();void loadRun(target.dataset.lastRun).then(()=>document.querySelector('section[aria-label="Run report"]')?.scrollIntoView?.({block:'start'}));return;}
  if(target.dataset.run){void loadRun(target.dataset.run);return;}
  if(target.dataset.readNotification){void markNotification(target.dataset.readNotification);return;}
  if(target.dataset.openNotification){void openNotification(target.dataset.openNotification);return;}
  if(target.dataset.tab){document.querySelectorAll('details[data-details="tabs-more"],details[data-details="pip-menu"]').forEach(d=>d.removeAttribute('open'));S.tab=target.dataset.tab;S.create=false;S.overview=false;if(S.tab==='job'&&personalPip())openPipPage();rememberView();render();if(S.tab==='memory'){void loadMemories();if(S.apiVersion>=19)void loadStatements();}else if(S.tab==='notifications')void loadNotifications();else if(S.tab==='chat')void loadMessages();else if(S.tab==='runs')void loadSelected(true);else if(S.tab==='job')void loadModels();else if(S.tab==='context'&&S.apiVersion>=12){if(!outcomeSessionsLoaded)void loadOutcomeSessions();if(!outcomeLoaded)void loadOutcomes();}else if(S.tab==='handoffs'&&!S.handoffsLoaded)void loadHandoffs();return;}
  if(target.dataset.recordException!==undefined){void reviewException(Number(target.dataset.recordException));return;}
  if(target.dataset.revokeStatement){revokeStatementReview(target.dataset.revokeStatement);return;}
  if(target.dataset.revokeMemory){revokeMemoryReview(target.dataset.revokeMemory);return;}
  if(target.dataset.executionReview){
    try{const r=executionReview(S.run?.execution_review,S.runId),status=target.dataset.executionReview;if(!r||status===r.status||!['accepted','dismissed','open'].includes(status)||S.run?.status!=='succeeded')return;
      draft.findingReviewReason='';openReview({title:status==='accepted'?'Accept this result?':status==='dismissed'?'Dismiss this result?':'Reopen this result?',description:'This only records your decision about this result. It doesn’t apply, merge or deploy anything, or mean every test passed.',body:'',reasonRequired:true,note:'Note (optional)',autoReason:'Reviewed in the Pips view.',confirm:status==='accepted'?'Accept':status==='dismissed'?'Dismiss':'Reopen',request:{type:'review_pip_execution',run_id:S.runId,status,expected_revision:r.revision}});
    }catch(error){setError(error);}return;
  }
  if(target.id==='handoff-personal'){
    if(!remoteHost&&S.apiVersion>=30&&personalPip()&&!archived()&&S.run?.status==='succeeded'&&S.run.manifest?.run_kind==='personal_task'&&typeof S.run.result?.text==='string'){S.handoffDraft={personal:true,runId:S.runId,text:S.run.result.text,sourceName:S.pip.name};draft.handoffText=S.run.result.text;draft.handoffTask='';draft.handoffTarget='';S.tab='handoffs';S.error='';render();void loadHandoffs();}return;
  }
  if(target.id==='handoff-artifact'){
    try{const source=patchSource(S.run);if(!source)return;S.handoffDraft={runId:S.runId,artifact:source,sourceName:S.pip.name};draft.handoffTask='Test the accepted Patch changes with these commands.';draft.handoffTarget='';draft.handoffPaths='';draft.handoffTests='[]';draft.specialistExplorer=false;draft.specialistCritic=false;draft.specialistWorker=false;draft.specialistCalls='1';S.tab='handoffs';S.error='';render();void loadHandoffs();}catch(error){setError(error);}return;
  }
  if(target.dataset.handoffFinding!==undefined){
    try{if(currentTree()||!handoffSourceAllowed(S.run?.manifest))throw new Error('Handoffs need committed code. Switch this Pip to committed code in Settings, under Advanced.');const c=runCheckpoint(S.run?.checkpoint,{id:S.runId,pip_id:S.selected,workspace_id:S.workspace.id}),index=Number(target.dataset.handoffFinding),f=c?.findings[index];if(!f)return;S.handoffDraft={runId:S.runId,index,finding:f,sourceName:S.pip.name};draft.handoffTask='Investigate: '+f.title;draft.handoffTarget='';draft.handoffPaths=f.path;draft.handoffTests='[]';draft.specialistExplorer=false;draft.specialistCritic=false;draft.specialistWorker=false;draft.specialistCalls='1';S.tab='handoffs';S.error='';render();void loadHandoffs();}catch(error){setError(error);}return;
  }
  if(target.dataset.chatModel){reviewChatModel(target.dataset.chatModel);return;}
  if(target.dataset.setup){void openSetup(target.dataset.setup);return;}
  if(target.dataset.rejectSetup){void openSetup(target.dataset.rejectSetup,true);return;}
  if(target.dataset.handoff){void openSavedHandoff(target.dataset.handoff);return;}
  if(target.dataset.rejectHandoff){void openSavedHandoff(target.dataset.rejectHandoff,true);return;}
  if(target.dataset.lineagePip){void openLineage(target.dataset.lineagePip,target.dataset.lineageRun);return;}
  if(target.dataset.proposal){proposalReview(target.dataset.proposal);return;}
  if(target.dataset.reject){proposalReview(target.dataset.reject,true);return;}
  if(target.dataset.archive){const entry=S.context?.entries.find(e=>e.id===target.dataset.archive);if(entry)openReview({title:'Archive this note?',description:'Runs that start from now on won’t see it. Runs that already started keep it.',body:`<h3>${esc(entry.title)}</h3><p class="goal">${esc(entry.kind==='execution'?executionContextWords(entry.provenance):entry.content)}</p>`,confirm:'Archive',request:{type:'archive_workspace_context',workspace_id:S.workspace.id,entry_id:entry.id,expected_revision:S.context.revision}});return;}
  if(target.dataset.reviewFinding!==undefined){
    try{const c=runCheckpoint(S.run?.checkpoint,{id:S.runId,pip_id:S.selected,workspace_id:S.workspace.id}),index=Number(target.dataset.reviewFinding),f=c?.findings[index],status=target.dataset.reviewStatus;if(!f||!['accepted','dismissed','open'].includes(status)||status===f.review.status)return;
      draft.findingReviewReason='';openReview({title:status==='accepted'?'Accept this finding?':status==='dismissed'?'Dismiss this finding?':'Reopen this finding?',description:'This records your decision for this Pip only. It doesn’t confirm the model was right, mark the code as fixed, or add it to workspace context.',body:`<h3>${esc(f.title)}</h3><p class="mono">${esc(f.path)}:${f.line}</p><pre>${esc(f.evidence)}</pre>`,reasonRequired:true,note:'Note for the Pip (optional)',autoReason:'Reviewed in the Pips view.',confirm:status==='accepted'?'Accept':status==='dismissed'?'Dismiss':'Reopen',request:{type:'review_pip_finding',run_id:S.runId,finding_index:index,status,expected_revision:f.review.revision}});
    }catch(error){setError(error);}return;
  }
  if(target.id==='record-execution-context'){
    try{const run=S.run,r=executionReview(run?.execution_review,run?.id);if(!run||run.status!=='succeeded'||!r||r.status!=='accepted'||!S.context)return;
      const pin=handoffPin(run.manifest.handoff,run,S.workspace.id),e=executionResult(run.result?.execution,run.manifest.run_kind,pin.payload.action,pin.payload);
      openReview({title:'Save this result to context?',executionResultDigest:r.result_digest,description:'Future runs in this workspace will know which files changed and how each test ended. The model’s conclusions, the commands and their output aren’t included. Nothing is applied and no permission is given.',body:`<dl class="meta"><dt>Commit</dt><dd class="mono">${esc(run.manifest.source_revision)}</dd><dt>Files changed (in a private copy)</dt><dd>${e.changes.changed_files.length}</dd><dt>Test commands</dt><dd>${e.tests.length}</dd></dl><p class="muted">This is what happened at the time, not proof the code is correct now. If you review this result again later, this note doesn’t change; archive it in Context if you need to.</p>`,confirm:'Save to context',request:{type:'accept_pip_execution_context',workspace_id:S.workspace.id,run_id:run.id,expected_revision:S.context.revision,expected_review_revision:r.revision}});
    }catch(error){setError(error);}return;
  }
  if(target.dataset.finding!==undefined){const index=Number(target.dataset.finding),finding=report(S.run?.result)?.findings[index];if(!finding||!S.context)return;openReview({title:'Save this finding to context?',description:'Every Pip in this project sees the quoted code and the model’s conclusion in future runs, marked as the model’s view, not a checked fact.',body:`<h3>${esc(finding.title)}</h3><p class="mono">${esc(finding.path)}:${finding.line}</p><pre>${esc(finding.evidence)}</pre>`,confirm:'Save to context',request:{type:'accept_pip_finding',workspace_id:S.workspace.id,run_id:S.run.id,finding_index:index,expected_revision:S.context.revision}});return;}
  if(target.dataset.pipChoice!==undefined){
    // A tap answers with that choice; with words or files already in the box it joins them instead.
    const choice=target.dataset.pipChoice;
    if(draft.chatText.trim()||pendingImages().length||pendingFiles().length){chatEdit(()=>{draft.chatText=(draft.chatText.trim()?draft.chatText.trim()+' ':'')+choice;render();});$('chatText')?.focus();}
    else chatEdit(()=>{draft.chatText=choice;void sendChat();});
    return;
  }
  if(target.dataset.needsOpen){if(computerState.pip===S.selected&&computerState.value?.granted)void openComputerView();return;}
  if(target.dataset.needsDone){void finishedCheck();return;}
  if(target.dataset.allowSend){void allowSend(target.dataset.allowSend);return;}
  if(target.dataset.allowAlways){void allowSend(target.dataset.allowAlways,true);return;}
  if(target.dataset.allowDismiss){void allowDismiss(target.dataset.allowDismiss);return;}
  if(target.dataset.allowCreate){void allowCreate(target.dataset.allowCreate);return;}
  if(target.dataset.allowCreateAlways){void allowCreate(target.dataset.allowCreateAlways,true);return;}
  if(target.dataset.cardEditStart){startCardEdit(target.dataset.cardEditStart);return;}
  if(target.dataset.cardEditUndo){cardEdits.delete(target.dataset.cardEditUndo);render();return;}
  if(target.dataset.appLinkStart){void appLinkAction('start_pip_app_link',target.dataset.appLinkStart);return;}
  if(target.dataset.appLinkCheck){void appLinkAction('check_pip_app_link',target.dataset.appLinkCheck);return;}
  if(target.dataset.appLinkDecline){void appLinkAction('decline_pip_app_link',target.dataset.appLinkDecline);return;}
  if(target.dataset.appLinkDisconnect){void appLinkAction('disconnect_pip_app_link',target.dataset.appLinkDisconnect);return;}
  if(target.dataset.appLinkSettings){vscode.postMessage({type:'openSettings',section:'plugins'});return;}
  if(target.dataset.composerMore!==undefined){S.composerNoteOpen=!S.composerNoteOpen;render();document.querySelector('[data-composer-more]')?.focus();return;}
  if(target.dataset.borrowAllow){void borrowAnswer('allow_pip_borrow',target.dataset.borrowAllow);return;}
  if(target.dataset.borrowDecline){void borrowAnswer('decline_pip_borrow',target.dataset.borrowDecline);return;}
  if(target.dataset.borrowStop){void borrowAnswer('stop_pip_borrow',target.dataset.borrowStop);return;}
  if(target.dataset.ownAppAccept){void acceptOwnAppUpdate(target.dataset.ownAppAccept,target.dataset.ownAppDigest||'');return;}
  if(target.dataset.pluginAllow){void pluginAnswer('allow_pip_plugin',target.dataset.pluginAllow);return;}
  if(target.dataset.pluginDecline){void pluginAnswer('decline_pip_plugin',target.dataset.pluginDecline);return;}
  if(target.dataset.pluginRemove){void pluginAnswer('decline_pip_plugin',target.dataset.pluginRemove,true);return;}
  if(target.dataset.pluginSettings){vscode.postMessage({type:'openSettings',section:'plugins'});return;}
  if(target.dataset.pluginRun){void pluginRun(target.dataset.pluginRun);return;}
  if(target.dataset.pluginAlways){void pluginRun(target.dataset.pluginAlways,true);return;}
  if(target.dataset.pluginSkip){pluginSkip(target.dataset.pluginSkip);return;}
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
    case 'manage-skills':vscode.postMessage({type:'openSettings',section:'plugins'});break;
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
    case 'chat-model':S.composerPanel=S.composerPanel==='model'?'':'model';S.modelListOpen=false;S.composerNoteOpen=false;draft.chatModelSearch='';render();if(S.composerPanel){if(!S.models.length)void loadModels();$('chat-model-summary')?.focus();}break;
    case 'chat-model-summary':S.modelListOpen=!S.modelListOpen;render();(S.modelListOpen?$('chatModelSearch'):$('chat-model-summary'))?.focus();break;
    case 'chat-model-close':S.composerPanel='';render();$('chat-model')?.focus();break;
    case 'chat-context-toggle':S.composerPanel=S.composerPanel==='context'?'':'context';S.composerNoteOpen=false;render();if(S.composerPanel){void loadChatContext();$('chat-context')?.focus();}break;
    case 'chat-context-close':S.composerPanel='';render();$('chat-context-toggle')?.focus();break;
    case 'chat-refresh-models':void loadModels();break;
    case 'chat-permissions':S.composerPanel='';render();openReview({title:`What ${S.pip.name} can do`,description:personalPip()?(S.pip.computer_plan?`${S.pip.name} has its own computer: ${S.apiVersion>=54?'a desktop with a browser, apps and a Terminal that reach public websites, and files':'a browser, a Terminal that reaches public websites, and files'}. It can also read the apps you connected. ${levelState.pip===S.pip.id&&levelState.value&&levelState.value.level!=='ask'?levelNotice(levelState.value):'Anything it would send, submit or change waits for your Allow, unless you chose Always allow.'}${S.apiVersion>=44?(carefulState.pip===S.pip.id&&carefulState.value?.careful===false?' Careful mode is off.':' Careful mode: it asks before it opens a new site, and before anything it read from your apps goes onto a website.'):''}`:`${S.pip.name} reads what you share here and the apps you connected. It can’t send, buy or change anything without your OK.`):'It reads the code it was given. In chat it can’t run commands, open the running app, change files or permissions. Anything it runs or changes, you approve separately, in a handoff or its setup.',readOnly:true,request:{}});break;
    case 'older-messages':void loadMessages(true);void loadPosts(true);break;
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
    case 'run':runNow();break;
    case 'toggle-pip':if(archived())break;if(S.apiVersion>=16&&!canLifecycle()){setError('Refresh, then try again.');break;}void mutate({type:S.pip.status==='paused'?'resume_pip':'pause_pip',pip_id:S.selected,...(S.apiVersion>=16?{expected_lifecycle_revision:S.pip.lifecycle_revision}:{})});break;
    case 'archive-pip':reviewLifecycle(false);break;
    case 'restore-pip':reviewLifecycle(true);break;
    case 'show-archived':S.showArchived=!S.showArchived;render();break;
    case 'pips-more':void loadMorePips();break;
    case 'cancel-run':openReview({title:personalPip()?'Stop this?':'Cancel this run?',description:personalPip()?`${S.pip?.name||'It'} stops what it’s doing. It can take a moment.`:'It stops what it’s doing. It can take a moment.',body:'',confirm:personalPip()?'Stop':'Cancel run',danger:true,request:{type:'cancel_pip_run',run_id:S.runId}});break;
    case 'stop-all':openReview({title:'Stop all Pips?',description:'Every Pip on this computer pauses and stops what it’s doing. They stay stopped after DGC restarts.',body:'<p class="muted">To undo it: Resume Pips, then resume each Pip.</p>',confirm:'Stop all Pips',danger:true,request:{type:'stop_pips'}});break;
    case 'start-runner':if(remoteHost)break;void mutate({type:'pips_runtime',action:'start'});break;
    case 'resume-runner':if(remoteHost)break;openReview({title:'Resume Pips?',description:'Pips start again. Each Pip stays paused until you resume it.',confirm:'Resume Pips',request:{type:'pips_runtime',action:'resume'}});break;
    case 'disable':if(remoteHost)break;openReview({title:'Turn off Pips?',description:'Every Pip stops what it’s doing and pauses, then Pips turn off. Turning them on later keeps them stopped until you resume.',confirm:'Turn off',danger:true,request:{type:'pips_enable',enabled:false}});break;
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
        S.notice=`Always allowed: ${g.label}. This Pip will do this again without asking and tell you after. Take it back in its Settings, under Allowed without asking.`;
        showMessageReview(a);
      });
      break;
    }
    case 'simple-new':openNewPip();break;
    case 'create-core':void createSimplePip('core','Core');break;
    case 'simple-back':chatDrafts.set(S.selected,draft.chatText);S.overview=true;rememberView();render();break;
    case 'pips-settings-open':pipsSettings.view=pipsSettings.view||'computer';pipsSettings.confirmReset='';render();void loadPipsSettings();break;
    case 'pips-settings-close':pipsSettings.view='';render();break;
    case 'pip-page-back':S.pipPage='info';lookDirty=false;render();void loadRoutines();break;
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
      if(reviewBlocked(review)){review.error='This expired or was changed. Refresh and try again.';renderReview();return;}
      if(review.rejectFirst?.length){void rejectWaitingThenConfirm(review);return;}
      let reason;if(review.reasonRequired){reason=(review.note&&draft.findingReviewReason.trim())||review.autoReason||'Decided in the Pips view.';if(new TextEncoder().encode(reason).length>1000){review.error='That note is too long. Keep it under 1,000 characters (fewer with emoji or non-English text).';renderReview();$('findingReviewReason')?.focus();return;}}
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
          S.context=c;S.notice=result.replayed?'This result was already added. Nothing was added twice.':'Added to context. Nothing ran.';commandLoaded=false;void loadCommandReceipts();return;
        }
        if(['archive_pip','restore_pip'].includes(review.request.type)){const v=archivalResult(result,{...review.request,reason},S.workspace.id);S.pip=v.pip;S.jobs=S.jobs.map(p=>p.id===v.pip.id?v.pip:p);draft.findingReviewReason='';S.notice=v.replayed?`${v.pip.name} is already ${v.pip.status==='archived'?'archived':'restored'}.`:v.receipt.operation==='archive'?`${v.pip.name} is archived. Its chats and history are kept; Show archived brings it back.`:`${v.pip.name} is restored and paused. Resume it when you want it working again.`;
          // The founder: archiving "takes me back to its chat, it should just take me to Pips home".
          if(v.receipt.operation==='archive'){chatDrafts.set(S.selected,draft.chatText);S.overview=true;rememberView();}
          return;}
        if(['record_pip_statement','revoke_pip_statement'].includes(review.request.type)){
          const q={...review.request,...(reason?{reason}:{})},v=pipStatementResult(result,q,S.workspace.id,review.statementAnchor,review.statementMemory);
          if(q.type==='record_pip_statement'){draft.statementTitle='';draft.statementText='';draft.statementReason='';draft.statementExpiry='';statementRetry=null;}else draft.findingReviewReason='';
          S.notice=v.replayed?'This was already saved. Nothing was added twice.':q.type==='record_pip_statement'?'Added. Only this Pip sees it; nothing else changed.':'Removed. Runs that already started keep what they had.';statementLoaded=false;void loadStatements();return;
        }
        if(['record_pip_exception','revoke_pip_exception'].includes(review.request.type)){
          const m=pipMemory(result.memory,S.selected,S.workspace.id);if(typeof result.replayed!=='boolean'||(review.memoryRecord?(m.source.run_id!==review.request.run_id||m.source.finding_index!==review.request.finding_index||!pipExceptionSourceEqual(m.source,review.memorySource)):m.id!==review.request.memory_id||m.status!=='revoked'||m.revision!==1))throw Error('That didn’t save as expected. Refresh to see it.');
          draft.findingReviewReason='';draft.memoryExpiry='';S.notice=review.memoryRecord?(m.status==='revoked'?'That exception was already removed. Trying again didn’t bring it back.':'Exception added. Its findings and the workspace context didn’t change.'):'Exception removed. Runs that already started keep what they had.';memoryLoaded=false;void loadMemories();return;
        }
        if(['accept_pip_handoff','reject_pip_handoff'].includes(review.request.type)){
          const h=handoffRecord(result.handoff,S.selected,S.workspace.id);if(h.id!==review.request.handoff_id)throw new Error('That answer didn’t save for this handoff. Refresh to see it.');
          if(review.request.type==='accept_pip_handoff'&&(!record(result.run)||result.run.id!==h.run_id||result.run.pip_id!==h.target_pip_id))throw new Error('The run that started doesn’t match this handoff. Refresh to see it.');
          S.notice=review.request.type==='accept_pip_handoff'?'Approved. It starts as soon as it can.':'Rejected. Nothing runs.';draft.findingReviewReason='';void loadHandoffs();return;
        }
        if(['accept_workspace_session_outcome','reject_workspace_session_outcome'].includes(review.request.type)){
          if(result.workspace_id!==S.workspace.id)throw Error('That answer belongs to another project. Refresh to see it.');const p=sessionStatement(result.proposal,S.workspace.id),accepted=review.request.type==='accept_workspace_session_outcome';if(p.id!==review.request.proposal_id||p.digest!==review.request.expected_digest||p.status!==(accepted?'accepted':'rejected'))throw Error('That answer didn’t save for this statement. Refresh to see it.');
          if(accepted){const c=context(result.context,S.workspace.id),entry=c.entries.find(e=>e.id===p.entry_id&&e.kind==='session_outcome'&&e.provenance.proposal.id===p.id&&e.provenance.proposal_digest===p.digest);if(typeof result.replayed!=='boolean'||(!result.replayed&&(!entry||c.revision!==review.request.expected_context_revision+1)))throw Error('The context didn’t save as expected. Refresh to see it.');S.context=c;draft.outcomeTitle='';draft.outcomeText='';outcomeRetry=null;}
          S.notice=accepted?'Added to context. It wasn’t checked against a run, and it gives no permissions.':'Rejected. Nothing was added.';outcomeLoaded=false;void loadOutcomes();return;
        }
        if(review.request.type==='create_pip'){await finishCreate(result);return;}
        if(review.request.type==='review_pip_execution'){
          const r=executionReview(result.review,review.request.run_id);if(!r||r.status!==review.request.status||r.revision!==review.request.expected_revision+1)throw new Error('Your decision didn’t save as expected. Refresh the run.');
          if(S.run?.id===review.request.run_id)S.run={...S.run,execution_review:r};draft.findingReviewReason='';S.notice='Saved. Nothing was applied or merged.';return;
        }
        if(review.request.type==='accept_pip_execution_context'){
          const c=context(result.context,S.workspace.id),entry=c.entries.find(e=>e.kind==='execution'&&e.provenance.run_id===review.request.run_id&&e.provenance.review_revision===review.request.expected_review_revision);
          if(!entry||entry.provenance.result_digest!==review.executionResultDigest||c.revision!==review.request.expected_revision+1)throw new Error('The context didn’t save as expected. Refresh Context to see it.');
          S.context=c;S.notice='Saved to context. Nothing was applied, and no Pip got new permissions.';return;
        }
        if(review.request.type==='review_pip_finding'){const checkpoint=runCheckpoint(result.checkpoint,{id:review.request.run_id,pip_id:S.selected,workspace_id:S.workspace.id});if(!checkpoint)throw new Error('Your decision didn’t save as expected. Refresh the report.');if(S.run?.id===review.request.run_id)S.run={...S.run,checkpoint};draft.findingReviewReason='';}
        if(review.request.type==='pips_enable'){S.enabled=result.enabled===true;S.runner=null;}
        if(review.request.type==='record_workspace_context'){draft.contextTitle='';draft.contextContent='';}
        if(review.request.type==='accept_pip_update'){S.adaptationDirty=false;draft.adaptationReason='';S.scheduleDirty=false;S.modelDirty=false;draft.modelReason='';draft.scheduleReason='';}
        if(['accept_pip_update','reject_pip_update'].includes(review.request.type)&&S.approvalsLoaded)void loadApprovals();
        const named=S.pip?.name||'This Pip',aside=review.setsAside?` ${review.setsAside===1?'The other waiting change was':`The ${review.setsAside} other waiting changes were`} set aside, not approved.`:'';
        S.notice=review.request.type==='review_pip_finding'?'Saved. Workspace context didn’t change.':review.request.type==='stop_pips'?'All Pips are stopping.':review.request.type==='pips_enable'?'Pips are off.':review.request.type==='accept_pip_update'?`${named} is updated.${aside}`:review.request.type==='reject_pip_update'?`Dismissed. ${named} stays as it was.`:'Saved.';
        if(review.request.type==='accept_pip_update')S.notice+=keepRunningTold(result);
      });break;
    }
  }
});
document.addEventListener('click',event=>{const img=event.target.closest?.('#computer-screen');if(!img||!img.dataset.width||!S.review?.computerView)return;const r=img.getBoundingClientRect();if(!r.width||!r.height)return;void computerView('click',{x:Math.round((event.clientX-r.left)*Number(img.dataset.width)/r.width),y:Math.round((event.clientY-r.top)*Number(img.dataset.height)/r.height)});});
document.addEventListener('click',event=>{const server=event.target.closest?.('[data-app-connection]')?.dataset.appConnection;if(server)void chooseAppAccount(server);});
// A reply's details open below it. At the bottom of the conversation that is out of sight, so the panel comes into view
// (only as far as it must). A click, not the toggle: each redraw opens the panels left open, and must not scroll.
document.addEventListener('click',event=>{const details=event.target.closest?.('details.message-details > summary')?.parentElement;if(!details)return;requestAnimationFrame(()=>{if(details.open)details.querySelector('.message-provenance')?.scrollIntoView({block:'nearest'});});});
document.addEventListener('change',event=>{if(event.target.id==='app-window-mode'){const relative=event.target.value==='calendar_days';$('app-relative-window').hidden=!relative;$('app-fixed-window').hidden=relative;}if(event.target.id==='app-account'&&S.review?.appPicker){const choice=S.review.appPicker.choices[Number(event.target.value)];$('app-calendar-window').hidden=event.target.value===''||choice?.toolkit!=='googlecalendar';const extra=extraReadTools.includes(choice?.tool);$('app-query').placeholder=({googledrive:'File name, for example Budget',notion:'Page title, for example Reading',googlecontacts:'Name, for example Alex',googlecalendar:'Optional event search',gmail:'For example: is:unread'})[choice?.toolkit]||'';$('app-query-label').textContent=extra?'Name or title to search (required)':'Search query (optional)';$('app-read-notice').textContent=appReadNotices[choice?.toolkit]||'';$('app-query').required=extra;}});
async function enable(){
  if(!S.connected||!S.supported||S.busy)return;const epoch=S.epoch;S.busy=true;render();
  try{const result=await send('pips_enable',{enabled:true});if(epoch!==S.epoch||!S.connected)return;S.enabled=result.enabled===true;S.notice=result.message||'Local Pips enabled.';if(S.enabled)await initialize();}
  catch(error){if(epoch===S.epoch)setError(error);}finally{if(epoch===S.epoch){S.busy=false;render();}}
}
document.addEventListener('keydown',event=>{
  // Personal | Project keys, as the Sessions home's tabs take them: an arrow goes to the other tab, Home and End to
  // the first and the last, and the tab chosen takes the focus.
  if(!S.review&&event.target.dataset?.pipsTab&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();chooseScopeTab(event.key==='Home'?'personal':event.key==='End'?'project':scopeTab()==='personal'?'project':'personal',true);return;}
  if(!S.review&&event.target.id==='chatModelSearch'&&event.key==='Enter'){event.preventDefault();return;}
  if(!S.review&&S.composerPanel){if(event.key==='Escape'){event.preventDefault();const target=S.composerPanel==='context'?'chat-context-toggle':'chat-model';S.composerPanel='';render();$(target)?.focus();return;}if(['ArrowUp','ArrowDown'].includes(event.key)&&event.target.closest?.('.composer-model-options')){event.preventDefault();const items=[...document.querySelectorAll('[data-chat-model]:not(:disabled)')],at=items.indexOf(event.target);items[(at+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();return;}}
  if(event.key==='Escape'&&voiceMode?.active){event.preventDefault();voiceMode.end();return;}
  if(event.key==='Escape'&&(S.mic==='recording'||S.mic==='starting')){event.preventDefault();micCancel();return;}
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
  if((message.type==='voiceReady'||message.type==='mic'||message.type==='micLevels')&&message.from==='pips'&&voiceMode?.receive(message))return;
  if(message.type==='micLevels'&&message.from==='pips'){voiceBar?.push(message.levels);return;}
  if((message.type==='speak'||message.type==='speakAudio')&&message.from==='pips'){reader?.receive(message);return;}
  if(message.type==='mic'&&message.from==='pips'){
    const was=S.mic;micShow(message.state,message.mode==='send'?'send':'stop');
    if(message.error){if(message.kind==='info')S.notice=String(message.error);else S.error=String(message.error);}
    if(typeof message.text==='string'){if(message.text)dictatedToPip(message.text,message.mode==='send');else{S.notice='Nothing was heard. Try again, a little closer to the microphone.';render();}}
    else if(was!==S.mic||message.error)render();
    return;
  }
  if(message.type==='pipsReply'){broker.receive(message);return;}
  if(message.type==='pipsPluginLogos'){takePluginLogos(message.logos);return;}
  if(message.type==='pipsVisibility'){S.visible=message.visible===true;motion();if(S.visible)void refresh(false);return;}
  if(message.type==='pipsConnection'){
    if(message.generation !== undefined && message.generation === S.generation) return;
    S.generation=message.generation ?? null;
    savedView=options.getState?.()||savedView;S.epoch++;broker.reset();clearSelection();S.selected='';S.overview=true;restoreView=true;chatDrafts.clear();chatRequests.clear();chatPreferences.clear();draft.chatText='';chatHistory?.reset();S.workspace=null;S.projectEmpty=false;S.switching=false;S.currentWorkspaceId=null;S.folderOpen=message.folder!==false;S.jobs=[];setupSeq++;setupDetailSeq++;setupRows=[];setupLoading=false;setupError='';draft.setupTask='';S.types=[];S.models=[];S.defaultModel='';S.subscriptions=[];S.defaultEngine=null;S.modelsError='';S.modelsLoading=false;S.executionCapability=null;S.executionLoading=false;S.executionError='';draft.createModel='default';S.create=false;S.createStep='type';S.createType='';creationDrafts.clear();avatarIds.clear();S.runner=null;S.context=null;S.refreshing=false;S.busy=false;S.loading=false;S.error='';S.notice='';S.apiVersion=Number.isSafeInteger(message.apiVersion)?message.apiVersion:9;S.connected=message.connected===true;S.supported=message.supported===true;S.enabled=message.enabled===true;
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
return {async navigate(value){if(!S.workspace||!usable()){options.navigation=value;navigationPending=true;return;}try{await refresh(false);await navigateFromHost(value);}catch(error){setError(error);}},setMotionPaused(paused){motionPaused=paused===true;motion();},setVisible(visible){S.visible=visible===true;motion();if(S.visible)void refresh(false);},dispose(){if(disposed)return;disposed=true;window.clearTimeout(noticeTimer);window.clearTimeout(appLinkTimer);S.epoch++;broker.reset();window.clearInterval(pollingTimer);window.clearInterval(workingClock);window.clearTimeout(streamTimer);avatarObserver?.disconnect();characterCleanup?.();characterCleanup=null;for(const dispose of disposers)dispose?.();characterStyles.remove();if(embedded)shell.remove();}};

}
if(typeof window!=='undefined')window.DgcPips={mount:mountPips,mountSetupCards,mountDigestBar,mountHomePips};
if(typeof window!=='undefined'&&typeof acquireVsCodeApi==='function'&&!window.document.getElementById('pips-host')){
  const api=acquireVsCodeApi();
  mountPips({root:window.document,postMessage:message=>api.postMessage(message),getState:()=>api.getState?.(),setState:value=>api.setState?.(value),onMessage:listener=>{const handle=event=>listener(event.data);window.addEventListener('message',handle);return()=>window.removeEventListener('message',handle);}});
}
