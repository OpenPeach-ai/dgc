import {createConnectorInputs,mountConnectorInputs,readConnectorInputs,mountConnectorSummary} from './pipsConnectorForm.js';
import {connectorDraft,connectorDraftsPage,connectorCall,connectorInspection,actionStatus,calendarAccounts,calendarDraft,calendarDetails,extendedCalendar,sendAccounts,messageDraft,messageReview,messageHistory,messageStates,emailDraft,emailDraftsPage} from './pipsMessageReviews.js';
// One set of tokens for every page, first, so each page's own stylesheet can lean on it (media/shared/tokens.css).
import '../media/shared/tokens.css';
// One menu for every "+" and picker, as in Work and ChatDGC (window.DgcMenu).
import '../media/shared/menu.css';
import '../media/shared/menu.js';
import '../media/shared/pagehead.css';
import '../media/shared/pagehead.js';   // window.DgcPageHead: the header row Work, Chat, Library and Pips all wear
// The Project Folder dropdown, as over the Work sessions (window.DgcFolderPick).
import '../media/shared/folders.css';
import '../media/shared/folderpick.css';
import '../media/shared/folderpick.js';
// A computer's own mark, the maintainer's Portal, as he wrote it (src/pipComputerNames.js draws it).
import '../media/shared/portal.css';
// One card for everything that asks or reports, as in Work and ChatDGC (window.DgcCard).
import '../media/shared/card.css';
import '../media/shared/card.js';
// A card's answers as icons that turn into the full button, on Needs attention as on Home (window.DgcIconActions).
import '../media/shared/iconactions.css';
import '../media/shared/iconactions.js';
import {changeCard,scheduleWords} from './pipChangeCard.js';
import '../media/shared/doccard.css';
// The small sheet of its kind on a document's card (window.DgcFileSheet).
import '../media/shared/filesheet.css';
import '../media/shared/filesheet.js';   // an artifact or a document in a chat: one card on every surface (ui-04)
// The prompt box's shared pieces (pills, the picture island, the drop overlay, Stop), as in Work and ChatDGC.
import '../media/shared/composer.css';
import '../media/shared/composer.js';
// The bar for what is going on above the prompt box, as in Work and ChatDGC (window.DgcTray).
import '../media/shared/dialog.css';   // every popover's and dialog's lift and arrival, as in Work and ChatDGC (ui-08)
import '../media/shared/tray.css';
import '../media/shared/tray.js';
import './pips.css';
// DGC's own hover label, drawn in the page: the browser's own `title` tooltip is cut by the window's edge (window.DgcTip).
import '../media/shared/tip.css';
import '../media/shared/tip.js';
import '../media/messagequeue.js';
import '../media/messagequeue.css';
import '../media/trace.js'; // window.DgcTrace: a reply's steps replayed, the same dialog as Work and ChatDGC
import '../media/trace.css';
import '../media/genui.css';
import {accountChoices,accountReadPlan,appLabels,appReadNotices,appReadWords,extraReadTools,combineReadPlans} from './pipsAppPicker.js';
import './pipsTranscript.css';
import '../media/breakdown.js'; // window.DgcBreakdown: the context window part by part, as main DGC and ChatDGC draw it
import '../media/voicebar.js';  // window.DgcVoiceBar: the box while you dictate, as main DGC and ChatDGC show it
import '../media/voicebar.css';
import '../media/readaloud.js'; // window.DgcReadAloud: a reply read aloud, as main DGC and ChatDGC play it
import '../media/voicemode.js'; // window.DgcVoiceMode: a spoken conversation, as ChatDGC has it
import '../media/texthistory.js'; // window.DgcTextHistory: undo and redo for the chat box, as main DGC and ChatDGC have them
import '../media/numbered-list.js';
import '../media/pasteclean.js';  // window.DgcPasteClean: what a paste becomes, the same in all three chats
import '../media/mentions.js';   // window.DgcMentions: @ marks in the box and the bubble, the same in all three chats
import '../media/mentions.css';
import {messageMarkup,replyParts,executionCardMarkup,transcriptIcon} from './pipsTranscript.js';
import {patchChildren} from './pipsDomPatch.js';
import {runPostsPage,mergePosts,postMarkup,postShort,postStatus,timeline,shortReply,routineTitle as postRoutineTitle,runFixesPage,askable,FIX_ACTIVE,livePostMarkup} from './pipRunPosts.js';
import {latestActivity,activityEnded,activityParts,activityText,startedWords,routineStartedWords,elapsed} from './pipRunActivity.js';
import {mountSetupCards} from './pipSetupCards.js';
import {mountDigestBar} from './pipDigestBar.js';
let effortByKeys=false;      // the thinking slider's focus ring: see markEffortInput
let effortHeld=false,effortRedraw=false;   // the thinking slider is being dragged, and a redraw waits for its release
import {mountHomePips} from './pipHomeStrip.js';
import {healthMarkup,failedRoutine,foldRoutineLines,failedRoutineMarkup,quietLineMarkup,noteMarkup,routineNotes,withNotes} from './pipRoutineHealth.js';
import {appLink,appLinksPage,appLinkResult,shownAppLinks,appLinkMarkup,appLinkSettledMarkup,allowCardMarkup,calendarCardMarkup} from './pipAppLinks.js';
import {pipAppsPage,pipAppSwitched,pipAppsMarkup} from './pipApps.js';
import {pipSkillsPage,pipSkillSwitched,pipSkillsMarkup} from './pipSkills.js';
import {OWNERS_API,pipOwner,pipOwnerSet,workTitles,ownerMarkup} from './pipOwner.js';
import {GOALS_API,MAX_OBJECTIVE,goalRequest,pipGoal,pipGoalRead,goalLive,goalCardMarkup} from './pipGoal.js';
import {TEAM_MAX,pipFolder,folderName,foldersInUse,pipsByFolder,folderMarkup,pipFolderMarkup,teamPips,teamCount,teamExportMarkup,teamExportRequest,teamExported,teamImported,teamExportedNotice,teamImportedNotice} from './pipTeams.js';
import {githubLink,grokReply,importPrompt,sourceImported,sourceImportedNotice,githubImportMarkup,grokImportMarkup} from './pipImports.js';
import {pipKeysPage,pipKeyResult,waitingKeys,pipKeyCardMarkup,pipKeysPageMarkup,pipKeyRemovedNote} from './pipKeys.js';
import {pluginsPage,pluginResult,keyRequests,keyCardMarkup,shownPluginCards,pluginForServer,installedForServer,pluginCardMarkup,pluginActionMarkup,pluginsPageMarkup,pluginUsesPage,pluginUsesMarkup,argumentValues,editedArguments,PLUGIN_LEVELS} from './pipPlugins.js';
import {attentionPage,waitingOn,needWords,attentionMarkup,attentionAllMarkup,attentionCards,attentionSpot,setupCardMarkup,attentionNavigation,cardSelector,codeRow} from './pipAttention.js';
import {answerFor,sendItemAnswer,readVisits} from './pipCardAnswers.js';
import {notesPage,notesMarkup,keptMarkup} from './pipNotes.js';
import {workingNotesPage,dailyLogPage,workingNotesMarkup,dailyLogMarkup,learnCardMarkup,learnRequest} from './pipWorkingNotes.js';
import {carefulPage,carefulMarkup,carefulWords,heldRequestAnswers,reviewWords,wordsHtml,addressHtml,settledWords,isPayment,asksEveryTime,offersAlways,limitWords,asksWords,coversWords,coversDetail,isCode,codeWords,codeProblem,codeFieldMarkup,takeCode,tidyCodeField,pasteCode} from './pipCareful.js';
import {loginsMarkup,loginFormMarkup,readLoginForm,loginFormProblem,clearLoginForm} from './pipLogins.js';
import {pipLogins,pipLogin,SLOW_READ} from './pipsModel.js';
import {mergeChatPage} from './pipsModel.js';
import {livePlan,livePlanFromText,livePip} from './pipsModel.js';
import {cardNumber} from './pipCards.js';
import {eyesMarkup,eyesNotice} from './pipEyes.js';
import {levelPage,levelMarkup,levelNotice,levelMenuMarkup} from './pipLevels.js';
import {ONE_API,ALL as ONE_ALL,PERSONAL as ONE_PERSONAL,savedFilter,listRequest,attentionRequest,attentionFor,underFilter,orderPips,heldOrder,placeOf,newPipFolder} from './pipsOne.js';
import {payLimits,payDraft,payRequest,payNotice,payingNotice,payLimitsMarkup,payTotalMarkup,readUsd,dollars} from './pipPay.js';
import {sentPage,sentMarkup} from './pipSent.js';
import {CHAT_API,agentsPage,foundListMarkup,saidMarkup,askCardMarkup,answeredMarkup,handedMarkup,agentRowMarkup,retryAskMarkup,pillMarkup,agentMapMarkup,agentCardMarkup,mapMeta,cardMeta} from './pipChat.js';
import {AGENT_LIVE} from './pipFlow.js';
import {FLOW_API,took,fixesPage,fixAnswer,FIX_LIVE,findingsCardMarkup,fixAskMarkup,fixDecidedLine,fixingMarkup,fixEndedLine,waitingLineMarkup,waitingCardMarkup,reportRow,reportsTableMarkup} from './pipFlow.js';
import {infoTip,wireInfoTips} from './pipInfoTip.js';
import {watchButtons} from './buttonFit.js';
import {pipArtifacts,dashboardList,artifactsPageMarkup,artifactsSectionsMarkup,reportNotice} from './pipArtifacts.js';
import {templatePage,templateMarkup} from './pipTemplates.js';
import {borrowsPage,borrowResult,shownBorrows,borrowActive,borrowMarkup} from './pipBorrow.js';
import {PROJECTS_API,PROJECT_WORK_COMMAND,MOVED_ON,FOLDER_ICON,projectChoices,projectChanges,projectAnswer,shownProjectChanges,projectCardMarkup,needsComputerMarkup} from './pipProjects.js';
import './pipProjects.css';
import './pipChat.css';   // its chat as a conversation, with its sub-agents (Pips API 97): Work's parts, to Work's measures
import {routinesPage,routineDraft,routineFromDraft,shownRoutineCards,routineCardMarkup,routinesMarkup,routineFormMarkup,shortDate} from './pipRoutines.js';
import {webhook,reach as webhookReach,webhooksOffered,testLine as webhookTestLine,webhookPanelMarkup,reachMarkup} from './pipWebhooks.js';
import {pickerMarkup,createPicker} from './pipPicker.js';
import {createChatFollow,AT_BOTTOM_PX} from './pipsFollow.js';
import {computerNames,computerNameProblem,cleanComputerName,urgentComputerState,computerIconWords,computersMenuMarkup,computerNamesMarkup} from './pipComputerNames.js';
import {conversationsPage,conversation,conversationTitle,conversationsMarkup,newConversationMarkup,routinePostsMarkup,computersWords,CONVERSATION_TITLE_MAX} from './pipConversations.js';
import {profile,sharedPage,computersPage,appsPage,headMarkup,pageTabsMarkup,infoMarkup,instructionsMarkup,characterMarkup,linksMarkup,mediaMarkup,filesMarkup,computersMarkup,appsMarkup as appsSettingsMarkup,BODIES} from './pipProfile.js';
import {pipSetup,pipSetups,pipSetupPrompt,pipSetupResolution,appReadPlan,webReadPlan,webReadLabel,SEVERITIES,pipNotifySettings,pipOutcomes,githubReadPlan,githubReadLabel,pipsKeepRunning,pipsDesktopNotifications,pipsPayments,pipBackup,fallbackOn,pipUsage,pipFeedback,actionGrants,actionGrant,pipComputer,pipComputerDesktop,pipComputerAction,pipComputerView,pipComputerFrame,pipComputerFrames,pipComputerFiles,pipComputerPointer,pipEyes} from './pipsModel.js';
import '../media/pips/plush.js';
import {ownAppsPage,ownAppForServer,ownAppsMarkup,isOwnApp,ownAppDecision,ownAppDecisionNotice,ownAppDecisionMarkup} from './pipOwnApps.js';
import {PIP_STATEMENT_NOTICE,pipStatementCandidate,pipStatement,pipStatementsPage,pipStatementDraft,pipStatementResult} from './pipsModel.js';
import {COMMAND_OUTCOME_NOTICE,commandReceipt,commandReceiptsPage,commandRecording,commandOutcomeEntry,commandOutcomeSummary} from './pipsModel.js';
import {outcomeWords,reviewStatusWords,commandLine,executionContextWords,notificationWords,eventWords} from './pipsModel.js';
import {esc,record,active,statusLabel,personalStatusLabel,errorText,report,runner,context,presentation,requestBroker,execution,activityPage,activityLabel,scheduleLabel,scheduleFromDraft,approvalStatus,approvalsPage,pipTypes,pipType,pendingReviews,messagesPage,chatContinuity,pipModels,modelChoice,pipRouter,routerChoices,defaultRunsOn,modelLabel,modelValue,subscriptionUsage,runCheckpoint,checkpointsPage,checkpointBaseline,executionPip,pulsePip,pulsePlan,pulsePlanEqual,pulsePlanFromCommands,pulseRunPins,pulseVerificationPin,pulseVerificationReceipt,pulseCommandLabel,pulseProgress,handoffAction,handoffRecord,handoffsPage,handoffPin,executionResult,executionReview,patchArtifactSource,documentationPip,documentationDraft,savedProposal,ADAPTATION_MODES,adaptationPolicy,adaptationLabel,adaptationsPage,EVENT_TRIGGER_NAMES,commitPathRules,commitPathObservation,eventTrigger,eventTriggerLabel,eventTriggerFromDraft,eventRunPin,draftAutomationPin,sourcePolicy,sourcePolicyLabel,sourceSnapshot,sourcePin,sourceResult,sourceRules,sourceWithExcludes,sourceExcludeError,sourceLeftOut,leftOutLines,sourceCheck,sizeText,MAX_SOURCE_EXCLUDES,SESSION_STATEMENT_NOTICE,sessionGeneration,sessionSourceSelection,sessionStatement,sessionStatementsPage,workspaceSessionsPage,pipNotification,notificationsPage,notificationNavigation,PIP_MEMORY_NOTICE,pipExceptionSourceEqual,pipExceptionCandidate,pipMemory,pipMemoriesPage,pipMemoryPin,SPECIALIST_ROLES,specialistGrant,specialistPolicy,specialistReceipt,lifecycleRevision,archivalResult} from './pipsModel.js';


// The main DGC chat mounts one instance in a ShadowRoot; the editor document is a fallback.
export const PIPS_API_VERSION=9;
export function mountPips(options) {
  const nativeDocument=window.document,root=options.root||nativeDocument;
  const embedded=root!==nativeDocument,owner=root.ownerDocument||nativeDocument,disposers=[];
  if(typeof DgcCard!=='undefined')disposers.push(DgcCard.watch(embedded?root.host:nativeDocument.body,root));   // a card's chips stay on one line ("+N")
  if(typeof DgcIconActions!=='undefined')disposers.push(DgcIconActions.watch(root));   // a card's icons turn into the full button when pointed at or reached by Tab
  if(typeof DgcMenu!=='undefined'&&DgcMenu.slide)DgcMenu.slide(root);   // a long model name slides while its row is pointed at (9 Nov)
  const remoteHost=options.host==='remote';
  let disposed=false,motionPaused=false;
  // A notice says what just happened, then goes: longer ones stay long enough to read. Errors stay, and so does a
  // notice someone may need to act on later (noticeStays: the folder a deletion left in place), until another replaces it.
  let noticeShown='',noticeTimer=0,noticeStays='';
  function noticeFades(){
    if(!S.notice){noticeShown='';return;}
    if(S.notice===noticeShown)return;
    noticeShown=S.notice;window.clearTimeout(noticeTimer);
    if(S.notice===noticeStays)return;
    const shown=S.notice;noticeTimer=window.setTimeout(()=>{if(!disposed&&S.notice===shown){S.notice='';noticeShown='';render();}},Math.min(15000,4000+60*shown.length));
  }
  if(embedded){
    const uri=options.stylesheetUri||root.host?.dataset.styleUri;
    if(options.stylesheetText){const style=owner.createElement('style');style.textContent=options.stylesheetText;root.append(style);disposers.push(()=>style.remove());}else if(uri){const link=owner.createElement('link');link.rel='stylesheet';link.href=uri;root.append(link);disposers.push(()=>link.remove());}
    const shell=owner.createElement('div');shell.className='pip-app-root embedded-pips'+(remoteHost?' remote-pips':'');shell.innerHTML='<main id="app"></main><div id="review-root"></div>';root.append(shell);
  }else nativeDocument.body.classList.add('pip-app-root');
  const shell=embedded?root.querySelector('.pip-app-root'):nativeDocument.body;
  if(!remoteHost)shell.classList.add('extension-pips');
  // Every control's `title` shows as DGC's own label, inside this view (in the side bar's shadow root, or the tab).
  if(typeof DgcTip!=='undefined'){const tip=DgcTip.install({root,shell});disposers.push(()=>tip.dispose());}
  const document={
    ownerDocument:owner,
    head:embedded?root:nativeDocument.head,body:shell,
    get hidden(){return nativeDocument.hidden;},get activeElement(){return root.activeElement;},
    createElement:tag=>owner.createElement(tag),getElementById:id=>root.querySelector('#'+id),
    querySelector:selector=>root.querySelector(selector),querySelectorAll:selector=>root.querySelectorAll(selector),
    addEventListener(type,fn){const target=type==='visibilitychange'?nativeDocument:root;target.addEventListener(type,fn);disposers.push(()=>target.removeEventListener(type,fn));}
  };
const vscode = {postMessage:options.postMessage};
let dockPins=new Set(),dockKnown=false;   // what is pinned to the dock, once the host has said (a host with no dock never does)
// A reply's pictures fold away (media/pictureFold.js, through pipsTranscript.js): drawn in this page's root (a shadow
// root in the side bar), and a choice goes to the host, which keeps it.
globalThis.DgcPictureFold?.root(root);
if(!embedded)globalThis.DgcPictureFold?.host(message=>vscode.postMessage(message));
const broker = requestBroker(message => vscode.postMessage({...message,generation:S.generation}));
const $ = id => document.getElementById(id);
const S = {chatWaiting:[],posts:[],postsCursor:null,postsPip:'',postsLoaded:false,postsLoading:false,postsError:'',apiVersion:0,connected:false,supported:false,enabled:false,epoch:0,workspace:null,jobs:[],selected:'',pip:null,runs:[],run:null,runId:'',context:null,runner:null,tab:'chat',versions:[],cursor:null,historyLoaded:false,create:false,loading:false,refreshing:false,busy:false,error:'',notice:'',review:null,visible:true,generation:null,activity:null,activityLoading:false,activityError:'',approvals:[],approvalCursor:null,approvalsLoaded:false,approvalsLoading:false,approvalsError:'',scheduleDirty:false,scheduleDraftVersion:null};
const unreadByPip=new Map(),unreadTotals=new Map(),readFingerprints=new Map();
let lastUnreadAt=0,unreadLoading=false,markingRead=false;const convRead=new Map();
// Unread is asked only of the workspaces that hold Pips (14 Nov: one request for every workspace, all at once, over a
// profile with ~190 test folders left behind went past the requests the page and the editor let wait: "DGC is busy").
// The Personal one, the one in view, and every workspace a listed Pip works in; a few requests at a time.
function unreadSpaces(){
 const holding=new Set([...(one.pips||[]),...(S.jobs||[])].map(p=>p?.workspace_id).filter(Boolean));
 const here=[personalSpace(),projectSpace(),S.workspace].filter(Boolean).map(w=>w.id);
 return openableSpaces().filter(w=>w&&(here.includes(w.id)||holding.has(w.id)));
}
async function askFew(items,ask,most=6){
 const out=new Array(items.length);let next=0;
 const lane=async()=>{while(next<items.length){const at=next++;out[at]=await ask(items[at]);}};
 await Promise.all(Array.from({length:Math.min(most,items.length)},lane));
 return out;
}
async function loadUnread(force=false){
  if(remoteHost||S.apiVersion<69||!usable()||!S.workspaces?.length||unreadLoading||!force&&Date.now()-lastUnreadAt<15000)return;
  unreadLoading=true;const token=scope();
  try{const spaces=unreadSpaces();const pages=await askFew(spaces,w=>send('list_pip_unread',{workspace_id:w.id}));
    if(token!==scope())return;unreadByPip.clear();unreadTotals.clear();
    for(const page of pages){if(!record(page)||!Array.isArray(page.pips)||!spaces.some(w=>w.id===page.workspace_id))continue;
      unreadTotals.set(page.workspace_id,Number.isSafeInteger(page.total)?page.total:0);
      for(const item of page.pips)if(record(item)&&typeof item.pip_id==='string'&&Number.isSafeInteger(item.count)&&item.count>0&&typeof item.latest==='string'&&readFingerprints.get(item.pip_id)!==`${item.latest_message_id||''}|${item.latest_post_id||''}`)unreadByPip.set(item.pip_id,item);}
    lastUnreadAt=Date.now();noteArrivals();render();maybeMarkRead();
  }catch{}finally{unreadLoading=false;}
}
// A Pip's unread pill on the Pips page: its whole chat read, up to the newest reply and run post list_pip_unread named.
const readingPips=new Set();
// A message to a Pip can be up to 256 KB from Pips API 79 (Limits for everyone, 10 Nov; it was 4,000 characters). An older
// runtime keeps its old limit, so nothing is sent that it would refuse.
const CHAT_MAX_BYTES=256*1024,CHAT_MAX_CHARS=CHAT_MAX_BYTES;
function chatTooLong(text){
 const bytes=new TextEncoder().encode(text).length;
 if(S.apiVersion>=79)return bytes>CHAT_MAX_BYTES?`That message is ${Math.floor(bytes/1024).toLocaleString()} KB; one can be up to 256 KB. Attach the rest as a file.`:'';
 return text.length>4000||bytes>8192?'That message is too long. Keep it under 4,000 characters (fewer with emoji).':'';
}
function canMarkRead(item){return !remoteHost&&S.apiVersion>=69&&(typeof item.latest_message_id==='string'||typeof item.latest_post_id==='string');}
function markPipRead(pip){
  const current=unreadByPip.get(pip);if(!current||readingPips.has(pip)||!canMarkRead(current)||!usable())return;
  const message=typeof current.latest_message_id==='string'?current.latest_message_id:null,post=typeof current.latest_post_id==='string'?current.latest_post_id:null;
  const token=scope(),fingerprint=`${message||''}|${post||''}`,focused=document.activeElement?.dataset?.pipRead===pip;
  readingPips.add(pip);render();
  if(focused)[...document.querySelectorAll('[data-job]')].find(e=>e.dataset.job===pip)?.focus({preventScroll:true});   // the pill goes: its row keeps the keyboard
  void send('mark_pip_read',{pip_id:pip,...(message?{message_id:message}:{}),...(post?{post_id:post}:{})})
    .then(()=>{if(token!==scope())return;readFingerprints.set(pip,fingerprint);const now=unreadByPip.get(pip);
      if(now&&`${now.latest_message_id||''}|${now.latest_post_id||''}`===fingerprint){unreadByPip.delete(pip);if(unreadTotals.has(now.workspace_id))unreadTotals.set(now.workspace_id,Math.max(0,unreadTotals.get(now.workspace_id)-now.count));}
      lastUnreadAt=0;})
    .catch(error=>{if(token===scope())S.error=errorText(error);})
    .finally(()=>{readingPips.delete(pip);if(token===scope()){render();void loadUnread(true);}});
}
function maybeMarkRead(){
  // (S.focused: the window has the focus, as the host says with the view's visibility. A chat in front of a window
  // nobody is looking at reads nothing; it reads what it shows when the focus is back. "New" means not seen, 13 Nov.)
  if(markingRead||remoteHost||S.apiVersion<69||!S.selected||S.overview||S.tab!=='chat'||!S.visible||S.focused===false||document.hidden||
      !S.messagesLoaded||postsShown()&&!S.postsLoaded||S.messagesLoading||S.postsLoading)return;
  const log=root.querySelector('.conversation-log');if(!log||log.scrollHeight-log.scrollTop-log.clientHeight>40)return;
  const current=unreadByPip.get(S.selected);
  // With several conversations, the one on screen is read up to its own newest reply, wherever the Pip's newest is.
  const here=shownConversation(),key=convKey(S.selected,S.conv),newest=here?.unread?S.messages.findLast(m=>m.role==='assistant')?.id||null:null;
  if(!current&&!newest)return;
  const named=current&&S.messages.some(m=>m.role==='assistant'&&m.id===current.latest_message_id)?current.latest_message_id:null;
  const post=current&&chatPosts()&&S.posts.some(p=>p.run_id===current.latest_post_id)?current.latest_post_id:null;
  const viaPip=!!(named||post),message=named||newest;
  if(!message&&!post)return;
  const pip=S.selected,token=scope(),fingerprint=`${named||''}|${post||''}`;
  if(viaPip?readFingerprints.get(pip)===fingerprint:convRead.get(key)===message)return;
  markingRead=true;
  void send('mark_pip_read',{pip_id:pip,...(message?{message_id:message}:{}),...(post?{post_id:post}:{}),...(message?convArg():{})})
    .then(()=>{if(token===scope()&&S.selected===pip){if(viaPip)readFingerprints.set(pip,fingerprint);else convRead.set(key,message);lastUnreadAt=0;void loadUnread(true);if(here)void loadConversations();}})
    .catch(()=>{})
    .finally(()=>{markingRead=false;});
}
const onConversationScroll=event=>{if(event.target?.classList?.contains('conversation-log'))maybeMarkRead();};
root.addEventListener('scroll',onConversationScroll,true);
// The "i" beside a settings title: its sentence shows when pointed at, on focus and on a click (src/pipInfoTip.js).
disposers.push(wireInfoTips({root,shell,view:window}));
// A dialog's buttons are one box whatever their words; a main action whose words do not fit (Reject them and archive,
// Prepare setup card) takes the one wide size, never an ellipsis (src/buttonFit.js).
disposers.push(watchButtons(shell,'#review-root .dialog .actions button',window));
disposers.push(()=>root.removeEventListener('scroll',onConversationScroll,true));
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
const chatHistory=window.DgcTextHistory?window.DgcTextHistory.create({box:()=>$('chatText'),changed:()=>{const box=$('chatText');if(!box)return;draft.chatText=box.value;if(S.selected)chatDrafts.set(S.selected,draft.chatText);rememberMarks();rememberView();render();fitChatInput();}}):null;
const chatEdit=change=>chatHistory?chatHistory.record(change):change();
// The box's words as a message: the blank lines around them go, and the first line keeps its indentation.
const messageWords=text=>globalThis.DgcPasteClean?.trimDraft(text)??String(text||'').trim();
// The box holds @ marks where they were typed (media/mentions.js), so it is Work's kind of box: an editing host answering
// this page as a <textarea>. It is one element for the life of the page, never redrawn: the page's markup holds an empty
// slot (data-dom-own), and a redraw that replaced the slot gets this element back, marks, caret and all.
// `chatMarks`: per Pip, the draft's words and marks, for when the box comes back to it.
const Mentions=remoteHost?null:globalThis.DgcMentions;
const chatMarks=new Map();
let chatBox=null,chatPop=null,chatPicker=null,boxPip='',projectFiles=[],projectFilesAsked=false;
const rowTerminal='<svg class="pi-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 4 3.5 3.5L3 11M8 12h5"/></svg>';
function chatMarkLook(part){return{logo:part.kind==='plugin'?pluginLogoSrc(part.identity):'',plug:transcriptIcon('plug'),folder:FOLDER_ICON,faceStyles:false};}
function rememberMarks(pip=S.selected){if(!chatBox||!pip)return;const parts=chatBox.parts();if(parts)chatMarks.set(pip,{text:chatBox.el.value,parts});else chatMarks.delete(pip);}
// What this Pip can reach, and nothing else: the plugins it can call (a Personal Pip's), the other Pips of its own
// workspace (what it can hand work to and be told about), and the project's files for a Pip that reads them. It makes
// no Outputs: a Pip's chat has no Output menu and no artifact tools.
function chatMentionSources(){
 const others=(S.jobs||[]).filter(p=>p.id!==S.selected&&p.status!=='archived'&&p.name).slice(0,100).map(p=>{const body=profile(p.profile).body;return{pip_id:p.id,name:p.name,pip_type:personalPip(p)&&body?body:p.pip_type,kind:`${p.pip_type} Pip`,detail:`${personalPip(p)?'Personal':'Project'} · v${p.current_version} · ${p.id.slice(-8)}`};}).filter(p=>Mentions.PIP_TYPES.includes(p.pip_type));
 return{plugins:personalPip()?(S.pluginsInstalled||[]).map(p=>({id:p.plugin,name:p.name})):[],outputs:[],pips:others,pipsEmpty:'No other Pips here',files:personalPip()?[]:projectFiles,
  // This computer's projects (pips-21, API 91): naming one gives this Pip a private copy of it.
  projects:projectMentionsOn()?S.projectChoices:[]};
}
if(Mentions){
 const el=owner.createElement('div');el.id='chatText';el.className='mention-box';el.dataset.draft='chatText';el.setAttribute('data-dom-own','1');el.setAttribute('contenteditable','true');el.setAttribute('role','textbox');el.setAttribute('aria-multiline','true');el.setAttribute('aria-controls','chat-pop');el.setAttribute('aria-autocomplete','list');el.setAttribute('aria-haspopup','listbox');el.setAttribute('aria-expanded','false');
 chatPop=owner.createElement('div');chatPop.id='chat-pop';chatPop.className='pop pop-over';chatPop.setAttribute('role','listbox');chatPop.setAttribute('aria-label','Suggestions');chatPop.setAttribute('data-dom-own','1');
 chatBox=Mentions.box(el,{maxLength:CHAT_MAX_CHARS,faceStyles:false,edit:change=>chatEdit(change),pillOptions:chatMarkLook,cleanedChanged:()=>drawChatTray(),
  pasteBack:part=>part.kind==='plugin'?chatMentionSources().plugins.some(p=>p.id===part.identity):part.kind==='pip'?chatMentionSources().pips.some(p=>p.pip_id===part.identity)
   :part.kind==='project'?!!S.pip?.computer_plan&&chatMentionSources().projects.some(p=>p.workspace_id===part.identity):part.kind==='file'&&!personalPip()});
 chatPicker=Mentions.picker(chatBox,chatPop,{edit:change=>chatEdit(change),sources:chatMentionSources,pipsDetail:'This Pip\u2019s workspace · no work starts',
  refresh(){if(!personalPip()&&!projectFilesAsked){projectFilesAsked=true;vscode.postMessage({type:'pipsFiles'});}if(projectMentionsOn())void loadProjectChoices();},
  projectsDetail:'A private copy for this Pip to work in',
  // A Pip with no computer has nowhere to keep the copy: it is told to get one first, and no mark goes in.
  projectPick:()=>{if(S.pip?.computer_plan)return true;askForComputer();return false;},
  face:(it,i)=>{const index=it.pipRow?Mentions.PIP_TYPES.indexOf(it.pipRow.pip_type):-1;return index>=0?`<span class="pi-pip-face" aria-hidden="true">${window.PipConcepts.plush.markup({index,name:it.pipRow.name},'idle',`pickerPip${i}`,{includeStyles:false})}</span>`:'';},
  icon:it=>{if(it.projectRow)return `<span class="pi-icon pi-project-mark" aria-hidden="true">${FOLDER_ICON}</span>`;if(!it.pluginId)return rowTerminal;const src=pluginLogoSrc(it.pluginId);return `<span class="pi-icon pi-plugin-mark" aria-hidden="true" data-plugin-mark="${esc(it.pluginId)}">${src?`<img alt="" src="${esc(src)}">`:transcriptIcon('plug')}</span>`;},
  drawn:()=>hydratePluginLogos(),
  // The name is the words: the model reads "ask Scout", and what a Pip is comes beside them (named_pips).
  pipPart:p=>{const name=p.name.replace(/\s+/g,' ').trim();return{kind:'pip',label:name,wire:name,identity:p.pip_id,pipType:p.pip_type};},
  // A project's Pip reads the project: the path is the words.
  filePart:file=>({kind:'file',label:file.label,wire:file.label,identity:''}),
  // "/" at the start: a Personal Pip's commands (API 77). /setup asks a few questions, then it sets itself up (Undo).
  commands:()=>personalPip()&&S.apiVersion>=77&&!archived()?[{name:'setup',detail:'Set it up for a job: a few questions, then it changes itself (Undo)'}]:[]});
 if(chatBox.note)chatBox.note.id='chat-paste-note';   // what the bar's "paste" pill opens (ui-09: it was a row above the box)
 disposers.push(()=>chatBox.dispose());
}
// Put the box back in its slot after a redraw, and bring it up to date with what the page says it holds.
function syncChatBox(){
 if(!chatBox)return;
 const slot=$('chatText'),pop=$('chat-pop');
 if(pop&&pop!==chatPop)pop.replaceWith(chatPop);
 if(!slot)return;
 const el=chatBox.el,moved=slot!==el;
 if(moved)slot.replaceWith(el);
 const type=pipType(S.pip,S.types);
 el.placeholder=chatStyle()?`Ask ${S.pip?.name||''}`:`Message ${type?.name||'this Pip'}…`;
 el.setAttribute('aria-label',`Message ${type?.name||'this Pip'}`);
 el.disabled=archived()||!usable();
 const now=el.value,want=draft.chatText;
 if(boxPip!==S.selected||now!==want){
  if(boxPip!==S.selected)chatBox.forgetCleaned();
  const kept=chatMarks.get(S.selected);
  if(kept&&kept.text===want)chatBox.writeParts(kept.parts);
  else if(boxPip===S.selected&&now&&want.startsWith(now)){const at=now.length;chatBox.replace(at,at,want.slice(at));}
  else chatBox.writeParts(want?[want]:[]);
  boxPip=S.selected;
 }
}
function micShow(next,action=''){S.mic=['starting','recording','writing'].includes(next)?next:'idle';voiceBar?.state(S.mic,action);}
function micCancel(){micShow('idle');render();vscode.postMessage({type:'micCancel',from:'pips'});$('chatText')?.focus();}
/** What was said, at the caret of the Pip's box, spaced from its neighbours; then sent, when Send stopped it. */
// Where the caret was when the microphone was pressed: the box is redrawn while it records, and a redrawn box's
// caret is at its start.
let micCaret=null;
function dictatedToPip(text,send){
  const whole=draft.chatText||'',[start,end]=micCaret&&micCaret[1]<=whole.length?micCaret:[whole.length,whole.length];micCaret=null;
  const before=whole.slice(0,start),after=whole.slice(end);
  // Nobody can say an invisible character, so one in a transcript is the speech model's noise, and goes without a notice.
  const said=window.DgcPasteClean?.classify(text).clean??text;
  const piece=(before&&!/\s$/.test(before)?' ':'')+said+(after&&!/^\s/.test(after)?' ':'');
  chatEdit(()=>{if(chatBox&&$('chatText')===chatBox.el){chatBox.replace(start,end,piece);draft.chatText=chatBox.el.value.slice(0,CHAT_MAX_CHARS);rememberMarks();}else draft.chatText=(before+piece+after).slice(0,CHAT_MAX_CHARS);render();});
  const again=$('chatText');if(again){again.focus();const at=Math.min(draft.chatText.length,start+piece.length);again.setSelectionRange(at,at);}
  fitChatInput();
  if(send)void sendChat();
}
S.workspaces=[];S.currentWorkspaceId=null;S.folderOpen=true;S.projectEmpty=false;S.switching=false;S.showArchived=false;S.emailDrafts=[];S.emailDraftError="";S.calendarDrafts=[];S.calendarDraftError="";let emailDraftSeq=0,calendarDraftSeq=0;
S.composerPanel='';S.chatControls=null;S.continuity=null;
const chatPreferences=new Map();
const chatPreferenceQueues=new Map(),chatPreferenceVersions=new Map();
const chatQueues=new Map();
// The prompt box's saves of a Pip's own window and thinking (API 47) that haven't answered yet, and a count that moves
// when one starts or ends: a conversation read that overlapped a save never takes its choice back.
const chatOptionsSaving=new Set();let chatOptionsEpoch=0;
const chatActivities=new Map();
// A change a Personal Pip made about itself at once (Pips API 77, D6): which lines show their Details, and the one being
// undone now.
const ownDetailsOpen=new Set(),ownUndoErrors=new Map();let ownUndoing='';
const canUndoOwn=()=>S.apiVersion>=77&&usable()&&!archived();
async function undoOwnChange(id){
 if(ownUndoing||!canUndoOwn())return;const token=scope(),pip=S.selected;ownUndoing=id;ownUndoErrors.delete(id);render();
 try{
  const result=await send('undo_pip_change',{pip_id:pip,change_id:id});if(token!==scope())return;
  if(!record(result?.change)||result.change.id!==id)throw new Error('That didn\u2019t undo. Refresh to see where it stands.');
  // Its name, instructions, schedule and model as the host now has them, and the line saying Undone.
  ownUndoing='';await loadSelected();if(result.change.kind==='routine'&&S.routines)await loadRoutines();
 }catch(error){if(token===scope())ownUndoErrors.set(id,errorText(error));}
 finally{if(ownUndoing===id){ownUndoing='';render();}}
}
let setupEditing=false,setupRows=[],setupLoading=false,setupError='',setupSeq=0,setupDetailSeq=0;
// The browser may still name a zone by its old name (Chromium says Asia/Calcutta); the current name is
// what every runner has installed (Ubuntu 24.04+ keeps old names in tzdata-legacy).
const OLD_ZONES={'Asia/Calcutta':'Asia/Kolkata','Asia/Saigon':'Asia/Ho_Chi_Minh','Asia/Katmandu':'Asia/Kathmandu','Asia/Rangoon':'Asia/Yangon','Asia/Dacca':'Asia/Dhaka','Europe/Kiev':'Europe/Kyiv','America/Buenos_Aires':'America/Argentina/Buenos_Aires','America/Godthab':'America/Nuuk','Atlantic/Faeroe':'Atlantic/Faroe','Pacific/Truk':'Pacific/Chuuk'};
const browserZone=Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const defaultZone=OLD_ZONES[browserZone]||browserZone;
S.sourceDirty=false;S.sourceDraftVersion=null;S.adaptations=[];S.adaptationCursor=null;S.adaptationsLoaded=false;S.adaptationsLoading=false;S.adaptationsError='';S.adaptationDirty=false;S.adaptationDraftVersion=null;S.handoffs=[];S.handoffCursor=null;S.handoffsLoaded=false;S.handoffsLoading=false;S.handoffsError='';S.handoffDraft=null;S.executionCapability=null;S.executionLoading=false;S.executionError='';S.checkpoints=[];S.checkpointCursor=null;S.checkpointsLoaded=false;S.checkpointsLoading=false;S.checkpointsError='';S.types=[];S.createStep='type';S.createType='';S.overview=true;S.messages=[];S.messageCursor=null;S.messagesLoaded=false;S.messagesLoading=false;S.messagesError='';S.chatActiveRun=null;S.chatWaiting=[];S.omitted=0;S.models=[];S.defaultModel='';S.subscriptions=[];S.defaultEngine=null;S.router=null;S.modelsError='';S.modelsLoading=false;S.modelDirty=false;S.stream=null;
const creationDrafts=new Map(),avatarIds=new Map(),chatDrafts=new Map(),chatRequests=new Map(),chatReplies=new Map();let avatarSequence=0,avatarObserver=null,characterCleanup=null,messageSeq=0,streamSeq=0,streamLoading=false,selectionGeneration=0;
let savedView=options.getState?.(),restoreView=true,navigationPending=!!options.navigation;
let postsSeq=0,fixesSeq=0;
// What Ask DGC to fix did for each run of the open Pip (Pips API 65), read from DGC: run_id -> its latest fix. And the
// runs asked about just now, whose fix hasn't been read yet (run_id -> when), to say "Asking DGC…" until it is.
S.fixes=new Map();S.fixesPip='';const askingFix=new Map();
// Ask DGC to fix, once per run: kept with the view, as the Work chat keeps the prompt in its transcript (before Pips
// API 65; from 65 the post says what the fix itself did).
const askedRuns=new Set(Array.isArray(savedView?.asked)?savedView.asked.filter(r=>typeof r==='string'&&/^run_[0-9a-f]{32}$/.test(r)).slice(-100):[]);
// Needs attention's fold (attentionOpen) and Reject's moment to undo (rejectSoon), kept with the view.
const attentionFolded=new Set(Array.isArray(savedView?.attention_folded)?savedView.attention_folded.filter(k=>typeof k==='string').slice(-500):[]);
let attentionUserFolded=attentionFolded.size>0;
// The folders folded in the Personal list (pips-12), kept with the view.
const foldersClosed=new Set(Array.isArray(savedView?.folders_closed)?savedView.folders_closed.filter(f=>typeof f==='string'&&f.length<=80).slice(-100):[]);
const heldRejects=new Map(),REJECT_HOLD_MS=6000;
// Show all, opened on a run's result or a routine's reply (by run or message id): for this view only.
const shownInFull=new Set();
S.sidebarPinned=savedView?.sidebar_pinned===true;
function rememberView(){savedView={workspace_id:S.workspace?.id,scope_tab:S.workspace?scopeTab():undefined,...(S.apiVersion>=ONE_API?{pips_filter:one.filter}:{}),selected:S.selected,tab:S.tab,overview:S.overview,sidebar_pinned:S.sidebarPinned,conversations:Object.fromEntries([...convShown].slice(-20)),conversation_drafts:Object.fromEntries([...convDrafts].slice(-40)),conversations_hidden:convState.collapsed,drafts:Object.fromEntries([...chatDrafts].slice(-20)),draft_marks:Object.fromEntries([...chatMarks].slice(-20)),chat_queues:Object.fromEntries([...chatQueues].filter(([,list])=>list.length).slice(-20)),asked:[...askedRuns].slice(-100),attention_folded:[...attentionFolded].slice(-500),folders_closed:[...foldersClosed].slice(-100),goals_dismissed:[...goalsDismissed].slice(-100)};options.setState?.(savedView);}
const characterStyles=document.createElement('style');characterStyles.id='pips-plush-styles';characterStyles.textContent=window.PipConcepts.plush.styles;document.head.append(characterStyles);
let outcomeSessions=[],outcomeSessionsCursor='',outcomeSessionsMore=false,outcomeSessionsLoaded=false,outcomeSessionsLoading=false,outcomeSessionsError='',outcomeHistory=[],outcomeCursor=null,outcomeLoaded=false,outcomeLoading=false,outcomeError='',outcomeInspection=null,outcomeInspecting=false,outcomeSessionSeq=0,outcomeSeq=0,outcomeInspectSeq=0,outcomeReviewSeq=0,outcomeRetry=null;
let notifications=null,notificationItems=[],notificationLoading=false,notificationError='',notificationSeq=0,notificationMark='';
let memories=[],memoryCursor=null,memoryLoaded=false,memoryLoading=false,memoryError='',memorySeq=0,memorySourceSeq=0;
let statementRows=[],statementPage=null,statementLoaded=false,statementLoading=false,statementError='',statementSeq=0,statementAnchorSeq=0,statementInspecting=false,statementRetry=null;
let commandReceipts=[],commandCursor=null,commandMore=false,commandTotal=0,commandLoaded=false,commandLoading=false,commandError='',commandSession='',commandSeq=0,commandDetailSeq=0;
let pulseCommands=[{argv:[''],cwd:'.'}],commitRules=[{kind:'exact',path:''}];
// The Source section's Excluded folders (safe_source_v2, API 50), its size check and one run's left-out record.
let sourceExcludeList=[],sourceExcludeProblem='',sourceCheckState={pip:'',value:null,loading:false,error:''},runSourceState={run:'',value:null,error:''};
const draft = {pipFolderName:'',teamName:'',importLink:'',importReply:'',deletePipName:'',sourceExcludeInput:'',noteAdd:'',workingNotesText:'',pipLearnText:'',newPipName:'',newPipCharacter:'scout',quickKind:'manual',quickTime:'08:30',quickHours:'4',quickZone:defaultZone,feedbackNote:'',webReads:'',setupTask:'',verificationEnabled:false,pulseMode:'tests',liveCommands:'',statementKind:'fact',statementTitle:'',statementText:'',statementReason:'',statementExpiry:'',statementSource:'',specialistExplorer:false,specialistCritic:false,specialistWorker:false,specialistCalls:'1',memoryExpiry:'',outcomeSession:'',outcomeSourceKind:'commit',outcomeSourceValue:'',outcomeTitle:'',outcomeText:'',sourceMode:'committed_only',sourceReason:'',triggerContext:false,triggerFinding:false,triggerCommit:false,triggerSession:false,triggerPaths:false,triggerMinutes:'5',adaptationMode:'suggest_changes',adaptationName:false,adaptationSource:false,adaptationReason:'',handoffText:'',handoffTarget:'',handoffTask:'',handoffPaths:'',handoffTests:'[]',createModel:'default',pipModel:'default',modelReason:'',findingReviewReason:'',chatText:'',scheduleType:'manual',scheduleAt:'',scheduleCron:'0 9 * * 1-5',scheduleMinutes:'60',scheduleTime:'09:00',scheduleZone:defaultZone,scheduleReason:'',name:'',goal:'',source_ref:'HEAD',revisionGoal:'',revisionReason:'',contextKind:'decision',contextTitle:'',contextContent:''};
// The face-and-dropdown pickers (pipPicker.js): New Pip's job or character, and a Personal Pip's face on its page. A pick
// redraws what it changes, the big face and what follows it, and gives the dropdown's button the focus back.
const picker=createPicker({root:document,onPick(id,value){
 if(id==='new-pip-kind'&&S.review?.projectPip){if(pickProjectKind(value)){Object.assign(S.review,newProjectPipReview());renderReview();}}
 else if(id==='new-pip-character'&&S.review?.newPip){if(SIMPLE_CHARACTERS.includes(value)&&value!=='core'){draft.newPipCharacter=value;S.review.body=newPipBody();renderReview();}}
 else if(id==='pip-face'&&pageView()&&S.pipPage==='character'){if(BODIES.includes(value)){draft.lookBody=value;lookDirty=true;render();}}
 $(id)?.focus({preventScroll:true});
}});
// What the chat's scroll does, as Work's does. The Pip's first message is read from its start, until you have said something.
const chatFollow=createChatFollow({opening:()=>!S.sending&&!(S.messagesLoaded&&S.messages.some(m=>m.role==='user'&&m.intro!==true)),focusBox:()=>$('chatText')?.focus()});
disposers.push(()=>chatFollow.dispose());
let adaptationSeq=0,handoffSeq=0,handoffDetailSeq=0,checkpointSeq=0,refreshSeq=0,selectionSeq=0,detailSeq=0,historySeq=0,activitySeq=0,approvalSeq=0,polling=false,dialogReturn=null,lastMarkup='';
const observedAvatars=new WeakSet();
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
  if(!characterCleanup)characterCleanup=window.PipConcepts.plush.mount?.(document);
  if(typeof IntersectionObserver!=='function')return;
  if(!avatarObserver)avatarObserver=new IntersectionObserver(entries=>{for(const e of entries)e.target.classList.toggle('motion-offscreen',!e.isIntersecting);},{threshold:0});
  avatarObserver.disconnect();
  for(const node of document.querySelectorAll('.avatar')){
    if(!observedAvatars.has(node)){node.classList.add('motion-offscreen');observedAvatars.add(node);}
    avatarObserver.observe(node);
  }
}
const field = (key,label,textarea=false) => `<label>${esc(label)}${textarea?`<textarea data-draft="${key}" id="${key}">${esc(draft[key])}</textarea>`:`<input data-draft="${key}" id="${key}" value="${esc(draft[key])}" autocomplete="off">`}</label>`;
// A failed model request in a person's words, with what fixes it; its own answer one click away. Anything else as it was.
const errorMarkup = value => {
 if(!value)return '';
 // A read DGC took over a minute to answer (the page asked once more first): asked again with one click, no reload.
 if(String(value)===SLOW_READ)return `<p class="notice error" role="alert">DGC took over a minute to answer. <button type="button" class="message-send-again" data-pips-retry>Try again</button></p>`;
 const failed=window.DgcMarkdown?.modelFailure?.(String(value));
 if(!failed)return `<p class="notice error" role="alert">${esc(value)}</p>`;
 return `<p class="notice error" role="alert">${esc(failed.headline)} ${esc(failed.next)}${failed.fix?` <button type="button" class="message-send-again" data-open-models>Settings → Models</button>`:''}</p><details class="message-failure"><summary>Details</summary><span>${esc(failed.detail)}</span></details>`;
};
function setError(error) { S.error=errorText(error); render(); }
// DGC's queue of Pip controls was full for a moment: nothing ran, and DGC said to wait. The line goes as soon as a
// later control gets through, which shows there is room again (release check, 2026-11-03: it stayed on the Pips
// home and in Core's chat until a window reload).
const PIPS_BUSY='Too many pending Pip controls; wait and retry.';
// Checked once what that reply set off has run: a refresh says its error only after all its replies are in.
function clearBusy(){if(!disposed&&S.error===PIPS_BUSY){S.error='';render();}}
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
async function setKeepRunning(enabled,refresh=false){
 if(S.busy||!usable())return;const token=scope();S.busy=true;render();
 try{const value=pipsKeepRunning((await send('set_pips_keep_running',{enabled})).keep_running);if(token!==scope())return;keepState.value=value;keepState.error='';
  S.notice=refresh&&value.on&&!value.outdated?'Keep Pips running now starts this DGC.':value.on?(value.while_logged_out?'Pips keep running: they start when you log in, restart if they fail, and run while you are logged out.':'Pips keep running: they start when you log in and restart if they fail.'):'Pips no longer start on their own. They keep running now until you stop them.';}
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
// Paying by itself, in dollars (Pips API 96, agreed 13 Nov; src/pipPay.js). The 10 Nov count (three a day, across all
// Pips, in the runner's Controls) is retired. A Pip's own limits are on its page, under its rule for payments, only
// while it is at Do it all with "Let it pay"; Pips settings has the optional "All Pips together: up to $ a day". Only
// you set either, on this computer. A Pip never types a card number.
const PAY_API=96;
Object.assign(draft,{payUsd:'',payNoLimit:false,payCount:'',paySites:'',payTotal:''});
// All Pips together: get_pips_payments' {usd_per_day (null: none), spent_today}. Read when Pips settings shows it.
let payTotalState={value:null,loading:false,error:'',asked:false,invalid:'',dirty:false,busy:false};
async function loadPayTotal(){
 if(remoteHost||S.apiVersion<PAY_API||!usable()||payTotalState.loading)return;
 const token=S.epoch;payTotalState={...payTotalState,loading:true,asked:true};
 try{const value=pipsPayments((await send('get_pips_payments')).payments);if(token===S.epoch){payTotalState.value=value;payTotalState.error='';if(!payTotalState.dirty)draft.payTotal=value.usd_per_day===null?'':String(value.usd_per_day);}}
 catch(error){if(token===S.epoch)payTotalState.error=errorText(error);}
 finally{payTotalState.loading=false;if(token!==S.epoch)payTotalState.asked=false;render();}
}
async function savePayTotal(){
 if(payTotalState.busy||S.busy||!usable()||!payTotalState.value)return;
 const word=String(draft.payTotal??'').trim(),read=word?readUsd(word):{value:null};
 if(read.error){payTotalState.invalid=read.error.replace(', or choose No limit','');render();return;}
 const token=S.epoch;payTotalState.invalid='';payTotalState.busy=true;render();
 try{const value=pipsPayments((await send('set_pips_payments',{usd_per_day:read.value})).payments);if(token!==S.epoch)return;
  payTotalState.value=value;payTotalState.error='';payTotalState.dirty=false;draft.payTotal=value.usd_per_day===null?'':String(value.usd_per_day);
  S.notice=value.usd_per_day===null?'No limit for all Pips together now. Each Pip keeps its own.':`All your Pips together pay by themselves up to ${dollars(value.usd_per_day)} a day.`;}
 catch(error){if(token===S.epoch)payTotalState.invalid=errorText(error);}
 finally{payTotalState.busy=false;if(token===S.epoch)render();}
}
function payTotalSection(){
 if(remoteHost||S.apiVersion<PAY_API||!S.connected||!S.enabled)return '';
 if(!payTotalState.asked&&usable())void loadPayTotal();
 return payTotalMarkup(payTotalState.value,{esc,value:draft.payTotal,busy:payTotalState.busy||S.busy||!usable(),dirty:payTotalState.dirty,error:payTotalState.invalid||payTotalState.error});
}
// One Pip's limits: what DGC says of them (get_pip_level, where it says them; set_pip_pay_limits' answer), or null while
// it hasn't said. The boxes keep what you typed until Save or until you leave the Pip.
const payState={pip:'',limits:null,error:'',busy:false,dirty:false};
function resetPay(){payState.pip='';payState.limits=null;payState.error='';payState.busy=false;payState.dirty=false;Object.assign(draft,payDraft(null));}
/** DGC said this Pip's level (and, where it does, its limits): the page's copy follows, unless you are typing. */
function syncPay(pip,value){
 if(payState.pip!==pip){resetPay();payState.pip=pip;}
 if(!value?.pay||payState.busy)return;
 payState.limits=value.pay;
 if(!payState.dirty)Object.assign(draft,payDraft(value.pay));
}
function payFormMarkup(state){
 if(!state||state.paying!=='allow'||state.level!=='full'||payState.pip!==S.selected)return '';
 return payLimitsMarkup(payState.limits,{esc,draft,busy:payState.busy||levelState.busy||S.busy||!usable(),dirty:payState.dirty,error:payState.error,pipName:S.pip?.name||'It'});
}
async function savePayLimits(){
 if(payState.busy||S.busy||!usable()||payState.pip!==S.selected||levelState.value?.paying!=='allow')return;
 const made=payRequest(draft);
 if(made.error){payState.error=made.error;render();return;}
 const token=scope(),pip=S.selected,name=S.pip?.name||'This Pip';payState.error='';payState.busy=true;render();
 try{const value=payLimits(await send('set_pip_pay_limits',{pip_id:pip,...made.fields}),pip);if(token!==scope()||S.selected!==pip)return;
  payState.limits=value;payState.dirty=false;Object.assign(draft,payDraft(value));S.notice=payNotice(name,value);}
 catch(error){if(token===scope()&&S.selected===pip)payState.error=errorText(error);}
 finally{payState.busy=false;if(token===scope()){render();keepFocus('pip-pay-save');}}
}
document.addEventListener('submit',event=>{
 if(event.target.id==='pip-pay-form'){event.preventDefault();void savePayLimits();}
 else if(event.target.id==='pips-pay-total-form'){event.preventDefault();void savePayTotal();}
});
// Typing in a box: Save wakes, and "No limit" puts the amount away, without a redraw under the caret.
document.addEventListener('input',event=>{
 const key=event.target.dataset?.draft;
 if(key==='payTotal'){payTotalState.dirty=true;const save=$('pips-pay-total-save');if(save)save.disabled=payTotalState.busy||!usable();return;}
 if(!['payUsd','payNoLimit','payCount','paySites'].includes(key))return;
 payState.dirty=true;const save=$('pip-pay-save');if(save)save.disabled=payState.busy||!usable();
 if(key==='payNoLimit'){draft.payNoLimit=event.target.checked;const box=$('payUsd');if(box){box.disabled=draft.payNoLimit;if(draft.payNoLimit){box.value='';draft.payUsd='';}}}
});
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
 // outdated: the service DGC wrote still starts an older DGC install. Refreshing it is turning it on again, which
 // restarts the runner on Linux and macOS, so it waits while a Pip is working.
 const c=S.runner?.counts,working=!!c&&(c.queued+c.running+(c.cancelling||0))>0;
 const older=k.on&&k.outdated?`<p class="muted keep-running-note keep-running-older">${esc(working?'It still starts an older DGC. Refresh moves it to this one once no Pip is working.':'It still starts an older DGC. Refresh moves it to this one.')} ${button('keep-running-refresh','Refresh',S.busy||!usable()||working,'quiet')}</p>`:'';
 return `<label class="keep-running"><input type="checkbox" id="keep-running"${k.on?' checked':''}${S.busy||!usable()?' disabled':''}> Keep Pips running</label><p class="muted keep-running-note">${esc(note)}</p>${older}`;
}
// more: on the Pips home's bar, Controls is a "…" button (ui-07); its menu is the same.
function runnerMarkup(more=false) {
  if(!remoteHost&&(S.loading||!S.connected&&!S.connectFailed))return '';   // only connecting or loading: the logo says so, and no row says "Not connected"
  const r=S.runner,paused=r?.paused;
  const state=`<span class="runner-status${more?' dgc-pagehead-aside':''}"><i class="status-dot${r?.online?' online':''}" aria-hidden="true"></i>${!S.connected?'Not connected to DGC':!S.enabled?'Pips are off':r?(paused?'Pips stopped':r.online?'Pips running':'Pips not running'):'Can’t tell if Pips are running'}</span>`;
  const start=remoteHost?'':`${r&&!r.online&&!paused?button('start-runner','Start Pips',S.busy||!usable()):''}${paused?button('resume-runner','Resume Pips…',S.busy||!usable()):''}`;
  const counts=r?`<span class="muted">${r.counts.queued} waiting to start · ${r.counts.running} working</span>`:'';
  const controls=`${button('refresh','Refresh',!usable())}${button('stop-all','Stop all Pips…',!usable()||S.busy,'danger')}`;
  return `<div class="runner compact-runner">${state}${start}<details class="runner-controls" data-details="runner-controls">${more?`<summary id="runner-controls-toggle" class="${window.DgcPageHead.MORE}" aria-label="Controls" title="Controls: refresh, stop all Pips, turn Pips off">${window.DgcPageHead.DOTS}</summary>`:'<summary id="runner-controls-toggle">Controls</summary>'}<div class="runner-menu dgc-popover">${counts}${keepRunningMarkup()}${desktopNotificationsMarkup()}<div class="actions">${controls}</div><p class="muted">Stop all pauses every Pip on this computer and stops what they’re doing. To undo it, resume Pips here, then resume each Pip.</p>${remoteHost?'<p class="muted">To start or resume Pips, run <code>dgc pips resume</code> and <code>dgc pips serve</code> on that computer. From here you can’t turn Pips on or change how they run.</p>':button('disable','Turn off Pips…',S.busy||!usable())}</div></details></div>${r?.error?errorMarkup(r.error.message):''}`;
}
// Only connecting or loading: DGC's slash logo, breathing as the panel's own header does. The pulse is timed from the page's
// clock, so a redraw between connecting and loading carries on where it was.
function loadingMark(){return `<div class="pips-loading" role="status" aria-label="Loading Pips" style="--pulse:-${Math.round(performance.now()%2100)}ms"><svg viewBox="0 0 90 90" fill="currentColor" aria-hidden="true"><path d="M32 24 L20 30 L13 72 L25 66 Z"/><path d="M54 18 L42 24 L35 72 L47 66 Z"/><path d="M76 24 L64 30 L57 66 L69 60 Z"/></svg></div>`;}
// How long connecting may take before the page says it couldn't: the host says so at once when the backend stopped for good.
const CONNECT_WAIT_MS=45000;let connectTimer=0;
function waitForConnection(){window.clearTimeout(connectTimer);if(S.connected||S.connectFailed)return;connectTimer=window.setTimeout(()=>{if(!S.connected){S.connectFailed=true;render();}},CONNECT_WAIT_MS);}
function welcome() {
  if(remoteHost&&!S.connected)return `<div class="empty">${avatar('offline')}<h2>Computer disconnected</h2><p class="muted">Reconnect the approved computer to read current Pips and send commands over the encrypted connection.</p>${button('reconnect','Check connection')}</div>`;
  if(remoteHost&&!S.enabled)return '<div class="empty"><h2>Turn on Pips on that computer</h2><p class="muted">From here you can’t turn Pips on, choose a folder or start them.</p><code>dgc remote connect --pips</code></div>';
  if (!S.connected&&!S.connectFailed) return loadingMark();
  if (!S.connected) return `<div class="empty">${avatar('offline')}<h2>Connect to local DGC</h2><p class="muted">Pips uses the DGC process in this editor. No web account is needed.</p>${button('reconnect','Reconnect')}</div>`;
  // An API new enough for Pips that still says unsupported is the platform, not the version.
  if (!S.supported && S.apiVersion >= 41) return `<div class="empty"><h2>On Windows, Pips run in WSL</h2><p class="muted">Install DGC inside WSL and open your folder in the editor connected to WSL: Pips work there as on Linux. Everything else in DGC works here.</p></div>`;
  if (!S.supported) return `<div class="empty"><h2>Update DGC to use Pips</h2><p class="muted">This DGC is too old for Pips. Update it, then reconnect.</p>${button('reconnect','Reconnect')}</div>`;
  if (!S.enabled) return `<div class="empty">${avatar()}<h2>Meet your Pips</h2><p>Little helpers that work for you on this computer: they look things up, keep an eye on what you care about, and draft what you need.</p><p class="muted">Nothing is sent or changed without your OK. They use your DGC model.</p>${button('enable','Turn on Pips',S.busy,'primary')}</div>`;
  if (S.loading) return loadingMark();
  if (!S.types.length || !S.workspace) return `<div class="empty"><h2>Pips didn’t load</h2><p class="muted">Reconnect to try again.</p>${button('reconnect','Reconnect')}</div>`;
  return '';
}
function createMarkup() {
  if(S.workspace?.kind==='personal'&&S.createStep!=='describe')return `<section class="setup-compose"><h2>Your personal Pip</h2><p class="muted">Available across your projects on this computer. No project files or app access are inherited.</p><form id="create-form" class="form"><label for="personal-character">Character</label><select id="personal-character">${S.types.filter(t=>t.available).map(t=>`<option value="${esc(t.id)}"${t.id===S.createType?' selected':''}>${esc(t.name)}</option>`).join('')}</select>${field('name','Name')}${field('goal','What would you like help with?',true)}${modelPicker('createModel','Model',draft.createModel,S.workspace?.kind==='personal')}<p class="muted">Start a private conversation. App access must be separately supported and reviewed before email or calendar jobs can run.</p><button type="submit" class="primary">Create personal Pip</button>${button('cancel-create','Cancel',S.busy)}</form></section>`;

  if(S.workspace?.kind==='personal'&&S.createStep==='describe')return `<section class="setup-compose"><p class="step">Personal · across your projects</p><h2>What would you like a hand with?</h2>${startersMarkup('personal')}${importMarkup()}<p class="muted">Describe the task in your own words. DGC will prepare a setup card for your review.</p><form id="setup-prompt-form" class="form">${field('setupTask','Describe the job',true)}<p class="muted">For example: Help me plan my week every Sunday at 6 pm. Ask me what to include.</p>${options.onSetupPrompt&&!remoteHost?'<button type="submit" class="primary">Describe to DGC</button>':'<p>Describe the task in the main DGC chat.</p>'}</form><p class="muted">Private to this DGC profile. No project files or connected apps are included automatically.</p><div class="actions">${button('advanced-create','Choose a Pip myself',S.busy)}${button('cancel-create','Cancel',S.busy)}</div></section>`;
  if(S.createStep==='describe')return `<section class="setup-compose" aria-labelledby="setup-compose-title"><p class="step">Start with the job</p><h2 id="setup-compose-title">What should your Pip look after?</h2>${startersMarkup('project')}${importMarkup()}<p class="muted">Tell DGC the project, the task and when to do it. You check it on one card before anything starts.</p><form id="setup-prompt-form" class="form">${field('setupTask','Describe the job',true)}<p class="muted">For example: Review committed changes in this project daily at 11:00 in Asia/Kolkata. Also run once today.</p>${options.onSetupPrompt&&!remoteHost?'<button type="submit" class="primary"'+(S.busy||!usable()?' disabled':'')+'>Describe to DGC</button>':'<p class="notice">Describe it in the DGC chat on your computer. This view can’t send it there.</p>'}</form><p class="muted">Project: ${esc(S.workspace.name)}. DGC confirms the project folder with you. To check a running app, you approve its test commands separately.</p><div class="actions">${button('advanced-create',simpleMode()?'Choose a Pip myself':'Advanced: choose a Pip',S.busy)}${button('cancel-create','Cancel',S.busy)}</div></section>`;

  if(S.createStep==='type')return `<section class="type-picker" aria-labelledby="type-picker-title"><p class="step">Step 1 of 2 · Choose your Pip</p><h2 id="type-picker-title">Who’s right for this job?</h2><p class="muted">Scout, Lens, Rook and Lock read committed code. Patch fixes files and Pulse runs tests, each in a private copy and only as you approve. Quill writes private documentation drafts. Chatting with any Pip never changes your files.</p>${S.types.length?`<div class="type-grid">${S.types.map(t=>`<article class="type-card${t.available?'':' planned'}" data-type-card="${esc(t.id)}">${avatar(t.available?'idle':'offline',t,`choose-${t.id}`)}<div class="type-copy"><h3>${esc(t.name)}<span class="badge">${t.available?(executionPip(t)?'You approve each run':documentationPip(t)?'Drafts only':'Reads only'):'Planned'}</span></h3><p class="type-role">${esc(t.role)}</p><p class="muted">${esc(t.description)}</p>${!t.available?`<p class="type-reason">${esc(t.unavailable_reason)}</p>`:''}</div><button type="button" data-pip-type="${esc(t.id)}"${!t.available||S.busy||!usable()?' disabled':''}>${t.available?`Choose ${esc(t.name)}`:'Not available yet'}</button></article>`).join('')}</div>`:'<p class="notice error">Pip types are unavailable. Reconnect to retry.</p>'}<div class="actions">${button('cancel-create','Cancel',S.busy)}</div></section>`;
  const type=S.types.find(t=>t.id===S.createType);
  if(!type?.available)return '<p class="notice error">This Pip type is unavailable. Go back and choose an available type.</p>';
  return `<form id="create-form" class="form"><p class="step">Step 2 of 2 · Configure the job</p><div class="create-hero">${avatar('idle',type,`configure-${type.id}`)}<div><h2>Your ${esc(type.name)}</h2><p class="muted">${esc(type.role)} · ${executionPip(type)?'You approve each run':documentationPip(type)?'Private drafts':'Reads only'}</p></div></div><p>${esc(type.description)}</p><p class="muted">It runs when you ask, in ${esc(S.workspace?.name || 'this project')}. ${pulsePip(type)?'It can’t run any commands yet. After you create it, you can give it a command plan and a schedule.':executionPip(type)?'It runs only on a handoff you approve, never on a schedule.':documentationPip(type)?(S.apiVersion>=20?'After you create it, you can give it a schedule or have it run on events. It doesn’t take handoffs.':'Update DGC to give Quill a schedule or run it on events. It doesn’t take handoffs.'):'After you create it, you can give it a schedule.'} It reads only committed code from the branch or commit you choose.</p>${field('name','Name')}${field('goal','What it does',true)}${field('source_ref','Branch or commit')}${modelPicker('createModel','Model',draft.createModel,S.workspace?.kind==='personal')}<p class="muted">Use HEAD, a branch name or a commit. Uncommitted edits aren’t included. ${executionPip(type)?'Chatting with it never changes files. You approve every fix or test run separately; creating it allows neither.':documentationPip(type)?'Quill writes drafts with the model and quotes the exact code it used. It never changes or publishes your files.':'All of these read the code the same way; the character you pick doesn’t give it more access.'}</p><div class="actions">${button('back-types','Back',S.busy)}<button class="primary" type="submit"${S.busy||!usable()?' disabled':''}>${executionPip(type)?'Review what it can do…':'Create Pip'}</button>${button('cancel-create','Cancel',S.busy)}</div></form>`;
}
async function finishCreate(result){
  // (With the Project Folder dropdown a Pip may be made in another folder's project: it opens here, in its own.)
  const elsewhere=record(result.pip)&&typeof result.pip.workspace_id==='string'&&result.pip.workspace_id!==S.workspace.id&&foldersOn();
  if(!record(result.pip)||typeof result.pip.id!=='string'||result.pip.workspace_id!==S.workspace.id&&!elsewhere)throw new Error('Created Pip does not match this workspace.');
  creationDrafts.delete(S.createType);draft.name='';draft.goal='';draft.source_ref='HEAD';S.createType='';S.createStep='type';S.busy=false;
  if(elsewhere){projectsAll.read=false;void loadFolders();await navigateFromHost({pip:result.pip.id});return;}
  await select(result.pip.id);await refresh(true);
}
function rememberCreationDraft(){if(S.createType)creationDrafts.set(S.createType,{name:draft.name,goal:draft.goal,source_ref:draft.source_ref,createModel:draft.createModel});}
// The signed-in CLI is only the model transport. Project and Personal Pip
// tools still run through DGC's own approval and source policies.
function subscriptionChoices(){return S.apiVersion>=55?S.subscriptions||[]:[];}
// API 70: DGC Router, while it is on: any computer with the Pips job, or one system and model (list_pip_models' router).
function routerOffer(){return S.apiVersion>=70?S.router:null;}
// API 74: the API providers saved in Settings -> Models, each with its models. The default's row is the connection a
// Pip on Default runs on, so it lists that connection's models under its own name.
function savedProviders(){return S.apiVersion>=74?S.providers||[]:[];}
function providerOf(id){return savedProviders().find(p=>p.id===id);}
function providerRemoved(){const c=S.pip?.model_choice;return c?.mode==='provider'&&S.apiVersion>=74&&Array.isArray(S.providers)&&!S.modelsLoading&&!providerOf(c.provider);}
function routerLabel(choice){const value=modelValue(choice);const found=routerChoices(S.router).find(([v])=>v===value);return found?found[1]:modelLabel(choice);}
function defaultModelName(){return defaultRunsOn({router:S.router,default_engine:S.defaultEngine,default_model:S.defaultModel});}
// Default: the Pips default model set in Settings, else DGC's own (list_pip_models' default_model says which runs).
function defaultLabel(){return S.noProvider?'No provider':defaultModelName()?`Default (${defaultModelName()})`:'Default';}
// The composer's model chip: its words and its hover. On Default it says so, as the menu row does ("Default (NAS ·
// qwen3.5:9b)"): it read "NAS · qwen3.5:9b", the same as choosing that model. On the Router's any-system choice it
// fits a side bar ("DGC Router (any Pip sy…" was cut) and names the computer the last reply came from, which the
// reply keeps ("glm-5.3:cloud on Workstation (DGC Router)", dgc/pip_chat.py _answered_by); the hover says it all.
function chipModel(choice,current){
 if(choice?.mode==='provider'){const saved=providerOf(choice.provider);return{text:choice.model,title:saved?`${choice.model} · ${saved.name}`:choice.model};}
 if(choice?.mode==='subscription')return{text:modelLabel(choice),title:modelLabel(choice)};
 if(choice?.mode==='router'&&choice.system){const label=routerLabel(choice);return{text:label,title:`${label} (DGC Router)`};}
 if(choice?.mode==='router'){
  const last=[...S.messages].reverse().find(m=>m.role==='assistant'&&typeof m.model==='string'),answered=/^(.+) on (.+) \(DGC Router\)$/.exec(last?.model||'');
  return{text:answered?`DGC Router · ${answered[2]}`:'DGC Router',title:`DGC Router (any Pip system)${answered?` · the last reply came from ${answered[2]} · ${answered[1]}`:''}`};
 }
 if(current)return{text:current,title:current};
 return{text:defaultLabel(),title:defaultLabel()};
}
// The one plain line about usage, where a subscription is chosen: by name, or by following DGC's default.
function usageLine(value){const engine=value.startsWith('subscription:')?value.split(':')[1]:value==='default'&&S.defaultEngine?.available?S.defaultEngine.engine:'';const name=engine?modelLabel({mode:'subscription',engine}):'';return name?subscriptionUsage(name):'';}
function modelPicker(id,label,value,personal=false,short=false) {   // short: a Pip's Settings, where the "i" beside Model says where the list comes from
  const explicit=value.startsWith('model:')?value.slice(6):'',subs=subscriptionChoices(personal),usage=subs.length||value.startsWith('subscription:')?usageLine(value):'';
  const heldSub=value.startsWith('subscription:')?value.slice(13):'',subCut=heldSub.indexOf(':'),engine=subCut<0?heldSub:heldSub.slice(0,subCut),subModel=subCut<0?'':heldSub.slice(subCut+1);
  const routed=routerChoices(routerOffer()),routedValue=value==='router'||value.startsWith('router:');
  const providerValue=value.startsWith('provider:'),named=savedProviders(),heldProvider=providerValue?value.slice(9,value.indexOf(':',9)):'';
  const providerGroups=`${named.filter(p=>!p.default||p.id===heldProvider).map(p=>`<optgroup label="${esc(p.name)}">${p.models.map(id=>{const v=`provider:${p.id}:${id}`;return `<option value="${esc(v)}"${value===v?' selected':''}>${esc(id)}</option>`;}).join('')}</optgroup>`).join('')}${providerValue&&!named.some(p=>p.models.some(id=>`provider:${p.id}:${id}`===value))?`<option value="${esc(value)}" selected>${esc(value.slice(value.indexOf(':',9)+1))} · ${providerOf(heldProvider)?'not offered now':'provider removed'}</option>`:''}`;
  const routerGroup=routed.length||routedValue?`<optgroup label="DGC Router">${routedValue&&!routed.some(([v])=>v===value)?`<option value="${esc(value)}" selected>${esc(value==='router'?'DGC Router':value.slice(7).replace('/',' · '))} · not offered now</option>`:''}${routed.map(([v,l])=>`<option value="${esc(v)}"${value===v?' selected':''}>${esc(l)}</option>`).join('')}</optgroup>`:'';
  return `<label for="${id}"${short?' class="sr-only"':''}>${esc(label)}</label><select id="${id}" data-draft="${id}"${short?' aria-describedby="pipModelSays"':''}><option value="default"${value==='default'?' selected':''}>${esc(defaultLabel())}</option>${routerGroup}${explicit&&!S.models.some(m=>m.id===explicit)?`<option value="${esc(value)}" selected>${esc(explicit)} · not in current list</option>`:''}${S.models.map(m=>`<option value="model:${esc(m.id)}"${explicit===m.id?' selected':''}>${esc(m.name)}</option>`).join('')}${providerGroups}${subs.length||engine?`<optgroup label="Your subscriptions">${engine&&!subs.some(x=>x.engine===engine)?`<option value="${esc(value)}" selected>${esc(modelLabel({mode:'subscription',engine}))} · not signed in here</option>`:''}${subs.map(x=>`<option value="subscription:${esc(x.engine)}"${engine===x.engine&&!subModel?' selected':''}>${esc(x.name)}</option>${[...new Set([...(Array.isArray(x.models)?x.models:[]),...(engine===x.engine&&subModel?[subModel]:[])])].filter(id=>typeof id==='string'&&id).map(id=>`<option value="subscription:${esc(x.engine)}:${esc(id)}"${engine===x.engine&&subModel===id?' selected':''}>${esc(x.name)} · ${esc(id)}</option>`).join('')}`).join('')}</optgroup>`:''}</select>${usage?`<p class="muted" data-usage-line>${esc(usage)}</p>`:''}${S.modelsLoading?'<p class="muted" role="status">Loading models…</p>':''}${S.modelsError?`<p class="muted">${esc(S.modelsError)} ${button('refresh-models','Try again',S.modelsLoading||!usable(),'link')}</p>`:`<p class="muted">${short?'':`Models from your DGC connection${subs.length?', and your own subscriptions':''}. `}${button('refresh-models','Refresh list',S.modelsLoading||!usable(),'link')}</p>`}`;
}
async function loadModels(){
  if(!usable()||S.modelsLoading)return;const epoch=S.epoch;S.modelsLoading=true;S.modelsError='';render();
  try{const result=pipModels(await send('list_pip_models'));if(epoch!==S.epoch)return;S.models=result.models;S.defaultModel=result.default_model;S.subscriptions=result.subscriptions;S.defaultEngine=result.default_engine;S.router=pipRouter(result.router);S.providers=result.providers;S.noProvider=result.no_provider===true;S.modelsError=S.noProvider?'':result.error?errorText(result.error):'';}
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
function routineIcon(){return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v2.8h-2.8"/><path d="M8 5v3.2l2 1.3"/></svg>';}
function composerIcon(name){const paths={edit:'<path d="m10 2 4 4-8 8H2v-4Z M8 4l4 4"/>',shield:'<path d="M8 1.5 13 3.5v4c0 3-2 5-5 7-3-2-5-4-5-7v-4Z"/><path d="m6 8 1.3 1.3L10 6.5"/>',context:'<path d="M7 2a6 6 0 1 0 7 7H7Z"/><path d="M9 1.5V7h5.5A6 6 0 0 0 9 1.5Z"/>',up:'<path d="M8 14V2M3 7l5-5 5 5"/>',chevron:'<path d="m4 10 4-4 4 4"/>',stop:'<rect x="4" y="4" width="8" height="8" rx=".5"/>',image:'<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.8" r="1.1"/><path d="m2.5 11.5 3.5-3.5 2.5 2.5 2-2 3 3"/>',zap:'<path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8Z"/>',next:'<path d="m6 4 4 4-4 4"/>',check:'<path d="m3.5 8.5 3 3 6-7"/>',back:'<path d="M13 8H3M7 4 3 8l4 4"/>',add:'<path d="M8 3v10M3 8h10"/>',mic:'<rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5"/><path d="M3 8a5 5 0 0 0 10 0M8 13v1.5"/>'};return `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${paths[name]||''}</svg>`;}
function continuityMarkup(){
 const c=S.continuity;if(!c)return `<p class="composer-scope">${esc(S.pip?.name||'This Pip')} saves a summary of this chat after its next reply.</p>`;
 return `<details class="chat-continuity"><summary>Chat memory${c.summarized_messages?' · '+c.summarized_messages+' messages summarized':''}</summary><p class="muted">${esc(c.notice)}</p><p class="muted">${c.strategy==='mechanical'?'A short summary. Some details may be left out; your messages are still saved.':c.strategy==='model'?`A summary ${esc(S.pip?.name||'it')} keeps up to date.`:'It still sees every message; nothing needs summarizing yet.'}</p>${c.summary?`<pre>${esc(c.summary)}</pre>`:''}<p class="muted">Summarized by ${esc(c.provenance.model||'its model')}</p></details>`;
}
// The prompt box's model and context controls, as DGC's own: the chip names the model and its
// effort, its menu is the reasoning card (slider; the model list one click deeper), and the context
// chip shows how full the window is, with the same meter in its menu.
const EFFORT_NAME={off:'Off',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high'};
S.modelListOpen=false;S.modelTab='main';S.modelCustom='';S.modelProviderView=false;S.modelProviderChoice='';S.composerNoteOpen=false;S.chatContext=null;let chatContextSeq=0;
function composerNote(text){
 const long=text.length>160;
 return `<p class="composer-note${long&&!S.composerNoteOpen?' clamped':''}">${esc(text)}</p>${long?`<button type="button" class="composer-more" data-composer-more aria-expanded="${S.composerNoteOpen}">${S.composerNoteOpen?'Show less':'Show more'}</button>`:''}`;
}
async function loadChatContext(){
 if(remoteHost||S.apiVersion<44||!personalPip()||!usable()||!S.chatControls)return;
 const token=scope(),pip=S.selected,sequence=++chatContextSeq,size=chosenChatOptions().context_size;
 try{const v=await send('get_pip_chat_context',{pip_id:pip,context_size:size,...convArg()});if(token!==scope()||S.selected!==pip||sequence!==chatContextSeq)return;
  if(!record(v)||v.pip_id!==pip||v.context_size!==size||![v.used_tokens,v.recent_messages,v.summarized_messages].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('bad context');
  // Part by part (a DGC from before has none): drawn as text only, so a malformed one just isn't shown.
  const b=v.breakdown,parts=record(b)&&b.window===size&&Array.isArray(b.categories)&&b.categories.length<=32&&b.categories.every(c=>record(c)&&typeof c.id==='string'&&typeof c.label==='string'&&Number.isSafeInteger(c.tokens))?b:null;
  S.chatContext={...v,breakdown:parts};render();}
 catch{if(token===scope()&&sequence===chatContextSeq){S.chatContext=null;render();}}
}
function currentChatProvider(value){
 if(value.startsWith('provider:')){const id=value.slice(9,value.indexOf(':',9));return providerOf(id)?.default?'connection':'provider:'+id;}
 if(value.startsWith('subscription:'))return value.split(':').slice(0,2).join(':');
 if(value==='router'||value.startsWith('router:'))return 'router';
 if(value==='default'&&routerOffer()?.pips_default)return 'router';
 if(value==='default'&&S.defaultEngine?.available)return 'subscription:'+S.defaultEngine.engine;
 return 'connection';
}
function chatModelListMarkup(selected,locked,reviewed,current,subs,usage){
 // No provider: nothing to choose from yet, only the way to add one.
 if(S.noProvider)return `<div class="composer-model-list"><p class="composer-list-title dgc-menu-head">No provider yet</p><div class="composer-model-options" role="listbox" aria-label="Providers"><button type="button" class="composer-model-action dgc-menu-row" data-open-models><span class="composer-model-check dgc-menu-icon">${composerIcon('add')}</span><span class="composer-model-row">Add provider in Settings…</span></button></div></div>`;
 const routed=routerChoices(routerOffer());
 // Every provider saved in Settings, in its order, by its name, as Work lists them; a default on a host that isn't saved
 // stays "Current host", first. With only a subscription there is no host to choose: it isn't offered as an empty step.
 const named=savedProviders(),ownDefault=named.find(p=>p.default),hostKept=S.models.length||currentChatProvider('default')==='connection';
 const providers=[...(hostKept&&!ownDefault?[{key:'connection',label:'Current host'}]:[]),
  ...named.map(p=>p.default&&hostKept?{key:'connection',label:p.name}:{key:'provider:'+p.id,label:p.name}),
  ...(routed.length?[{key:'router',label:'DGC Router'}]:[]),
  ...subs.map(x=>({key:'subscription:'+x.engine,label:x.name}))];
 const provider=providers.some(x=>x.key===S.modelProviderChoice)?S.modelProviderChoice:currentChatProvider(selected);
 // The rows as Work's: a check where it is chosen, the name beside it.
 const row=(attr,value,label,on,sub='',off=locked,after='')=>`<button type="button" class="composer-model-option dgc-menu-row" role="option" ${attr}="${esc(value)}" aria-selected="${on}"${off?' disabled':''}><span class="composer-model-check dgc-menu-icon">${on?composerIcon('check'):''}</span><span class="composer-model-row dgc-menu-label" title="${esc(label)}">${esc(label)}${sub?`<small>${esc(sub)}</small>`:''}</span>${after}</button>`;
 // D14: a row DGC runs itself (your connection or a saved provider) has a ⋯ with Use as main and Use as fallback, and
// small Main and Fallback words; a subscription, the Router and Default have neither.
 const fallback=fallbackValue(pipFallback()),pills=(value,on)=>fallback?(on?DgcMenu.pill('Main','main'):'')+(value===fallback&&!on?DgcMenu.pill('Fallback','fallback'):''):'';
 const modelRow=(value,label,sub='',on=selected===value)=>{
  const plain=row('data-chat-model',value,label,on,sub,locked,pills(value,on));
  if(S.apiVersion<76||remoteHost)return plain;
  if(!fallbackChoice(value))return plain;
  const open=S.fallbackMenu===value,isFallback=value===fallback&&!on;
  const choices=open?`<div class="dgc-menu-choices" role="group" aria-label="${esc(label)}">${on?'':`<button type="button" class="dgc-menu-row composer-model-action" data-chat-model="${esc(value)}"${locked?' disabled':''}><span class="composer-model-row">Use as main</span></button>`}<button type="button" class="dgc-menu-row composer-model-action" data-chat-fallback="${isFallback?'':esc(value)}"${pipBackupState.busy||on?' disabled':''}><span class="composer-model-row">${isFallback?'Stop using as fallback':'Use as fallback'}</span></button></div>`:'';
  return DgcMenu.item(plain,DgcMenu.more(`More for ${label}`,`data-chat-model-more="${esc(value)}"`,open),choices);};
 const followsDefault=key=>currentChatProvider('default')===key?modelRow('default',defaultLabel()):'';
 if(S.modelProviderView)return `<div class="composer-model-list"><p class="composer-list-title dgc-menu-head">Provider</p><div class="composer-model-options" role="listbox" aria-label="Providers">${providers.map(x=>row('data-chat-provider',x.key,x.label,provider===x.key,'',false,composerIcon('next'))).join('')}<button type="button" class="composer-model-action dgc-menu-row" data-open-models><span class="composer-model-check dgc-menu-icon">${composerIcon('add')}</span><span class="composer-model-row">Add provider in Settings…</span></button></div></div>`;
 let rows='';
 if(provider==='connection'){
  rows=followsDefault('connection')+S.models.map(m=>modelRow('model:'+m.id,m.name,m.name!==m.id?m.id:'',selected==='model:'+m.id||(!!ownDefault&&selected===`provider:${ownDefault.id}:${m.id}`))).join('');
 }else if(provider.startsWith('provider:')){
  const saved=providerOf(provider.slice(9));
  rows=(saved?.models||[]).map(id=>modelRow(`provider:${saved.id}:${id}`,id)).join('');
 }else if(provider==='router'){
  rows=followsDefault('router')+routed.map(([value,label])=>modelRow(value,label,value==='router'?'Any computer with the Pips job':'')).join('');
 }else{
  // The CLI's own default, then its models, then any other by name: the same rows as Work and ChatDGC.
  const sub=subs.find(x=>'subscription:'+x.engine===provider),held=selected.startsWith(provider+':')?selected.slice(provider.length+1):'';
  const names=[...new Set([...(Array.isArray(sub?.models)?sub.models:[]),...(held?[held]:[])])].filter(id=>typeof id==='string'&&id);
  rows=followsDefault(provider)+(sub?modelRow(provider,'CLI default')+names.map(id=>modelRow(`${provider}:${id}`,id)).join('')
   +(S.modelCustom===provider?`<div class="composer-model-custom"><label class="sr-only" for="chat-model-custom">Model name</label><input id="chat-model-custom" data-model-provider="${esc(provider)}" placeholder="Vendor model id or alias" maxlength="256" spellcheck="false" autocomplete="off"></div>`
    :`<button type="button" class="composer-model-action dgc-menu-row" data-chat-model-custom="${esc(provider)}"${locked?' disabled':''}><span class="composer-model-check dgc-menu-icon">${composerIcon('edit')}</span><span class="composer-model-row">Enter another model…</span></button>`):'');
 }
 return `<div class="composer-model-list"><button type="button" id="chat-model-providers" class="composer-model-action dgc-menu-row"><span class="composer-model-check dgc-menu-icon">${composerIcon('back')}</span><span class="composer-model-row">Providers</span></button><p class="composer-list-title dgc-menu-head">${provider.startsWith('subscription:')?`${esc(subs.find(x=>'subscription:'+x.engine===provider)?.name||'Subscription')} model`:'Model'}</p>${reviewed?'<p class="composer-scope">You’ll confirm a new model before it’s used. Work already started keeps the old one.</p>':''}<div class="composer-model-options" role="listbox" aria-label="Available models">${rows}</div>${S.modelsLoading?'<p class="muted" role="status">Loading models…</p>':''}${S.modelsError&&provider==='connection'?errorMarkup(S.modelsError):''}${current&&provider==='connection'&&!S.modelsLoading&&!S.models.some(m=>m.id===current)?'<p class="muted">The current model is absent from this list. Its saved choice remains unchanged.</p>':''}${usage&&provider.startsWith('subscription:')?`<p class="muted" data-usage-line>${esc(usage)}</p>`:''}${S.modelsError&&provider==='connection'?button('chat-refresh-models','Refresh models',S.modelsLoading||locked):''}</div>`;
}
function chatControlsMarkup(canSend,busy){
 // Dictating: the bottom row is the voice bar (media/voicebar.js), which draws itself into whatever is rendered here.
 if(voiceMode?.active)return `<div class="composer-controls pip-voice">${talkBar.markup('conversation')}</div>`;
 if(S.mic!=='idle')return `<div class="composer-controls pip-voice">${voiceBar?voiceBar.markup():''}</div>`;
 const locked=archived()||!usable()||S.busy,current=S.pip.model_choice?.mode==='model'?S.pip.model_choice.model:'',selected=modelValue(S.pip.model_choice),chip=chipModel(S.pip.model_choice,current),shownModel=chip.text,available=S.apiVersion>=24&&!!S.chatControls,o=available?chosenChatOptions():null;
 const subs=subscriptionChoices(personalPip()),usage=subs.length?usageLine(selected):'';
 // D14: its own model is out and its fallback answers: the chip names the fallback, in olive, until its own model is back.
 const onFallback=S.fallbackOn&&!S.noProvider&&S.apiVersion>=76?S.fallbackOn:null;
 const unavailable=`<p class="composer-unavailable">${S.apiVersion<24?'Update DGC to change these settings.':'These settings didn’t load. Refresh, then send.'}</p>`;
 const ultraOn=pipUltra(),effortMax=ultraOffered()?5:4;
 const effortLabel=o?(ultraOn?'Ultra':EFFORT_NAME[o.thinking]||o.thinking):'';
 const effortStep=ultraOn?5:Math.max(0,chatThinkingLevels.indexOf(o?.thinking));
 const effort=o?`<div class="composer-effort-control" data-step="${effortStep}" data-full="${effortStep===effortMax?1:0}" style="--effort-t:${effortStep/effortMax}"><label class="sr-only" for="chat-thinking">Thinking</label><input id="chat-thinking" class="composer-effort-slider${effortByKeys?' by-keys':''}" type="range" min="0" max="${effortMax}" step="1" value="${effortStep}" aria-valuetext="${esc(ultraOn?'Ultra: up to 4 sub-agents at once':effortLabel)}" title="${esc(choiceScope())}"${locked?' disabled':''}><span class="composer-effort-face">${pipAvatar(S.pip,S.chatActiveRun?'working':'idle',`effort-${S.pip.id}`,pipType(S.pip,S.types)||characterType(S.pip.pip_type))}</span><div class="composer-effort-labels" data-at="${effortStep===0?'start':effortStep===effortMax?'end':''}"><span>Off</span><output for="chat-thinking">${esc(effortLabel)}</output><span>${effortMax===5?'Ultra':'Extra high'}</span></div></div>${composerNote(choiceScope()+' '+S.chatControls.reasoning_note)}`:unavailable;
 const reviewed=!personalPip();
 // The two tabs under the model row and the slider, as in Work's menu (live round 1, 14 Nov): once DGC has said how
 // many sub-agents this Pip runs (Pips API 97). An older DGC has no sub-agents for a Pip, so no tabs.
 const tabbed=ultraOffered(),agentsTab=tabbed&&S.modelTab==='agents';
 const modelTab=(id,label,on,tip)=>`<button type="button" class="model-tab" role="tab" id="chat-model-tab-${id}" data-model-tab="${id}" aria-selected="${on}" tabindex="${on?0:-1}" title="${esc(tip)}">${label}</button>`;
 const modelTabs=tabbed?`<div class="model-tabs" role="tablist" aria-label="Main model, or sub-agents">${modelTab('main','Main model',!agentsTab,'This Pip’s model')}${modelTab('agents','Sub-agents',agentsTab,`Sub-agents: ${pipAgentsWords()}`)}</div>`:'';
 const list=chatModelListMarkup(selected,locked,reviewed,current,subs,usage);
 const modelMenu=S.composerPanel==='model'?`<div class="composer-model-menu composer-reasoning dgc-menu from-right" role="dialog" aria-label="Model and thinking"><button type="button" id="chat-model-summary" class="composer-model-summary" aria-expanded="${S.modelListOpen}">${composerIcon('zap')}<span class="composer-summary-label">${esc(shownModel)}${o?` <span class="muted">${esc(effortLabel)}</span>`:''}</span>${composerIcon('next')}</button>${effort}${modelTabs}${agentsTab?pipAgentsTabMarkup(shownModel):S.modelListOpen?list:''}</div>`:'';
 const sizes=o?[...new Set([2048,4096,8192,16384,32768,65536,131072,262144,524288,1048576,o.context_size])].filter(n=>n<=S.chatControls.context_max).sort((a,b)=>a-b):[];
 // No provider: no model anyone chose, so no window to measure against, and no number.
 // On a subscription the CLI keeps its own window, whose size DGC doesn't know: no setter, and no percentage of a number it never uses.
 const cliRoute=currentChatProvider(selected),cliName=cliRoute.startsWith('subscription:')?(subs.find(x=>'subscription:'+x.engine===cliRoute)?.name||modelLabel({mode:'subscription',engine:cliRoute.slice(13)})):'';
 const ctx=!S.noProvider&&!cliName&&o&&S.chatContext&&S.chatContext.pip_id===S.selected&&S.chatContext.context_size===o.context_size?S.chatContext:null,pct=ctx?Math.min(100,Math.round(ctx.used_tokens/ctx.context_size*100)):null;
 const meter=ctx?`<div class="ctx-head"><div><span class="ctx-kicker">Context window</span><strong>${ctx.used_tokens.toLocaleString('en-US')} / ${ctx.context_size.toLocaleString('en-US')}</strong></div><span class="ctx-pct">${pct}%</span></div>${ctx.breakdown?`<div class="pip-ctx-breakdown" data-sig="${esc(ctx.breakdown.used+':'+ctx.breakdown.categories.map(c=>c.id+'='+c.tokens).join(','))}"></div>`:`<div class="ctx-track" aria-hidden="true"><span style="width:${pct}%"></span></div><div class="ctx-split"><span>${Math.max(0,ctx.context_size-ctx.used_tokens).toLocaleString('en-US')} free</span><span>${ctx.recent_messages} recent message${ctx.recent_messages===1?'':'s'}${ctx.summarized_messages?` · ${ctx.summarized_messages} in its brief`:''}</span></div>`}`:`<div class="ctx-head"><div><span class="ctx-kicker">Context window</span></div></div>`;
 const contextMenu=S.composerPanel==='context'?`<section class="composer-model-menu composer-context-menu dgc-menu from-right" role="dialog" aria-label="Context window">${meter}${cliName?`<p class="composer-scope composer-cli-window">${esc(cliName)} manages its own context window, so there is no size to set here.</p>${continuityMarkup()}`:o?`<div class="composer-context-size"><label for="chat-context">Window size</label><select id="chat-context" aria-label="Context window" title="${esc(choiceScope())}"${locked?' disabled':''}>${sizes.map(n=>`<option value="${n}"${o.context_size===n?' selected':''}>${n===1048576?'1M':n%1024===0?n/1024+'K':n.toLocaleString()}</option>`).join('')}</select></div>${composerNote(`${choiceScope()} Pips supports 2,048–${S.chatControls.context_max.toLocaleString()} tokens; main DGC requests ${S.chatControls.inherited_context_size.toLocaleString()}. ${S.chatControls.context_note}`)}${continuityMarkup()}`:unavailable}</section>`:'';
 // An empty box offers voice mode where Send is, as ChatGPT does; a word typed, and it's Send again.
 const offerVoice=!!voiceMode&&!busy&&canSend&&!draft.chatText.trim()&&!(canAttachImages()&&(pendingImages().length||pendingFiles().length));
 const sendAction=`<button type="submit" class="chat-send${canSend&&(draft.chatText.trim()||canAttachImages()&&(pendingImages().length||pendingFiles().length))?' ready':''}" aria-label="${busy?'Send mid-turn update':'Send message'}" title="${busy?'Send mid-turn update':'Send message'}"${canSend?'':' disabled'}>${composerIcon('up')}</button>`;
 const action=offerVoice?`<button type="button" id="chat-voicemode" class="chat-send ready" aria-label="Voice mode" title="Voice mode: talk with ${esc(S.pip?.name||'this Pip')}"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 6.5v3M6 4v8M10 3v10M13 6v4"/></svg></button>`:busy?`<button type="button" id="chat-stop" class="composer-chip" title="Stop generation" aria-label="Stop generation"${S.busy||!usable()?' disabled':''}>${globalThis.DgcComposer?.STOP||composerIcon('stop')}</button>${S.apiVersion>=73?sendAction:''}`:sendAction;
 const routineCount=(S.routines||[]).filter(r=>r.status==='on').length;
 const routineChip=keepsAll()&&S.apiVersion>=43?`<button type="button" id="chat-routines" class="composer-routines" aria-label="Routines: ${routineCount} on" aria-haspopup="dialog" aria-expanded="${S.composerPanel==='routines'}" title="Manage ${esc(S.pip.name)}’s routines">${routineIcon()}<span>Routines</span>${routineCount?`<b>${routineCount}</b>`:''}</button>`:'';
 // The level (Pips API 58): a chip with the level's name where Work's mode picker is. It replaces the shield, whose "What
 // it can do" is its menu's last row (U6, 7 Nov). It works while a reply runs: a change applies from the next step. A
 // Project Pip always asks, and an older or remote DGC has no levels: the shield stays.
 const lv=levelShown()&&levelState.pip===S.pip.id?levelState.value:null,lvName=lv?(lv.levels.find(l=>l.level===lv.level)||{}).name||'':'';
 const levelChip=levelShown()?`<button type="button" id="chat-level" class="composer-chip with-text composer-level" title="How much ${esc(S.pip.name)} asks before it acts${lvName?': '+esc(lvName):''}" aria-label="Before ${esc(S.pip.name)} acts${lvName?': '+esc(lvName):''}" aria-haspopup="menu" aria-expanded="${S.composerPanel==='level'}"${usable()?'':' disabled'}>${composerIcon('shield')}${lvName?`<span class="composer-level-name">${esc(lvName)}</span>`:''}</button>`
  :`<button type="button" id="chat-permissions" class="composer-chip" title="What ${esc(S.pip.name)} can do" aria-label="What this Pip can do">${composerIcon('shield')}<span class="sr-only">What it can do</span></button>`;
 const levelMenu=S.composerPanel==='level'&&levelShown()?`<div class="composer-level-menu dgc-menu" role="menu" aria-label="Before ${esc(S.pip.name)} acts">${levelMenuMarkup(lv,{esc,pipName:S.pip.name,busy:levelState.busy,error:levelState.error})}</div>`:'';
 // "+": the same menu as Work's and ChatDGC's (media/shared/menu.js), in place of the picture chip (U3, 7 Nov).
 const addMenu=S.composerPanel==='add'&&canAttachImages()?`<div class="composer-add-menu dgc-menu" role="menu" aria-label="Add">${globalThis.DgcMenu?.html([{name:'Add to the message',rows:[{id:'upload',label:'Pictures and files',hint:'From this computer'},{id:'mention',label:personalPip()?'A Pip or an app':'A file in this project',hint:'@'}]},...(goalsOn()?[{name:'This chat',rows:[{id:'goal',label:'Set a goal',hint:'It keeps going until it is done'}]}]:[])],{data:'pip-add'})||''}</div>`:'';
 return `${modelMenu}${contextMenu}${addMenu}${levelMenu}${providerRemoved()?'<p class="composer-unavailable" role="alert">The provider this Pip runs on was removed from Settings. Choose another model for it.</p>':''}<div class="composer-controls"><div class="composer-left">${canAttachImages()?`<button type="button" id="chat-attach" class="composer-chip" title="Add pictures, files and more" aria-label="Add pictures, files and more" aria-haspopup="menu" aria-expanded="${S.composerPanel==='add'}"${S.busy||archived()?' disabled':''}>${composerIcon('add')}</button><input type="file" id="chat-attach-input" accept="${[...PIP_IMAGE_TYPES,...(spoolsPhotos()?[...PIP_HEIC_TYPES,'.heic','.heif']:[]),...PIP_FILE_EXTENSIONS].join(',')}" multiple hidden>`:''}${S.noProvider?'':`<button type="button" id="chat-context-toggle" class="composer-chip${pct===null?'':' with-text'}" title="${cliName?`${esc(cliName)} manages its own context window`:`Context window${o?' · '+o.context_size.toLocaleString()+' tokens':''}${pct===null?'':' · '+pct+'% used'}`}" aria-label="Context window${cliName?`: ${esc(cliName)} manages its own`:pct===null?'':': '+pct+' percent used'}" aria-haspopup="dialog" aria-expanded="${S.composerPanel==='context'}">${composerIcon('context')}${pct===null?'':`<span class="composer-ctx-pct">${pct}%</span>`}</button>`}${routineChip}${levelChip}</div><div class="composer-right">${convOn()?pillMarkup(agentsNow(),{esc,open:agentsUi.map}):''}<button type="button" id="chat-model" class="model-control${onFallback?' on-fallback':''}" aria-label="Change model and thinking${onFallback?`. ${esc(onFallback.model)}, its fallback, is answering`:''}" aria-haspopup="dialog" aria-expanded="${S.composerPanel==='model'}" title="${esc(onFallback?`${chip.text} didn’t answer, so its fallback ${onFallback.model} is answering. It tries ${chip.text} again with your next message.`:chip.title)}${o?' · '+esc(effortLabel):''} — change model and thinking"${locked?' disabled':''}><span class="composer-model-icon" aria-hidden="true">${composerIcon('zap')}</span><span class="model-copy"><span class="composer-model-name">${esc(onFallback?onFallback.model:shownModel)}</span>${onFallback?'<span class="composer-fallback-word">fallback</span>':''}${o?`<span class="composer-effort-name">${esc(effortLabel)}</span>`:''}</span><span class="composer-chevron">${composerIcon('chevron')}</span></button>${voiceBar?`<button type="button" id="chat-mic" class="composer-chip" title="Dictate" aria-label="Dictate"${!usable()||archived()||busy?' disabled':''}>${composerIcon('mic')}</button>`:''}${action}</div></div>`;
}
function fitChatInput(){const input=$('chatText');if(!input)return;
 // (Send alone is lit by what there is to send. The voice button, drawn where Send is while the box is empty, keeps its
 // circle: this pass took it away after every redraw, so it flickered when a menu opened: live round 1, 14 Nov.)
 const sendButton=document.querySelector('.chat-send:not(#chat-voicemode)');sendButton?.classList.toggle('ready',!sendButton.disabled&&!!draft.chatText.trim()||!sendButton.disabled&&canAttachImages()&&(pendingImages().length>0||pendingFiles().length>0));if(!input.isConnected||input.clientWidth<40||document.hidden)return;input.style.height='auto';const content=input.scrollHeight,capped=content>=160;input.style.overflowY=capped?'auto':'hidden';input.style.height=(capped?160:content+1)+'px';}
// What the prompt box's choices are for: since API 47 they are this Pip's own (its replies and the work it does on
// its own, saved at once); before, only the next reply.
function choiceScope(){return S.apiVersion>=47?'For this Pip: its replies and the work it does on its own.':'For the next reply.';}
function saveChatPreference(pip,options){
 if(S.apiVersion<47||remoteHost)return;
 const token=scope(),version=(chatPreferenceVersions.get(pip)||0)+1;
 chatPreferenceVersions.set(pip,version);chatOptionsSaving.add(pip);chatOptionsEpoch++;
 // A quick effort change after a window change must not let an older response write last.
 const previous=chatPreferenceQueues.get(pip);
 const perform=async()=>{
  const v=await send('set_pip_chat_options',{pip_id:pip,chat_options:options});
  if(token!==scope()||S.selected!==pip||version!==chatPreferenceVersions.get(pip))return;
  if(!record(v))throw Error('DGC did not confirm the saved Pip options.');
  S.chatControls=checkedChatControls(v.chat_controls);render();
 };
 const pending=(previous?previous.catch(()=>{}).then(perform):perform()).catch(error=>{
  if(token===scope()&&S.selected===pip&&version===chatPreferenceVersions.get(pip)){
   chatPreferences.delete(pip);setError(error);void loadMessages();
  }
 }).finally(()=>{
  if(version===chatPreferenceVersions.get(pip)){
   chatPreferenceQueues.delete(pip);chatOptionsSaving.delete(pip);chatOptionsEpoch++;
  }
 });
 chatPreferenceQueues.set(pip,pending);
}
function updateChatPreference(kind,value){
 if(S.apiVersion<24||!S.chatControls||!S.selected||!usable()||S.busy||archived())return;
 try{const previous=chosenChatOptions(),next=checkedChatOptions({...previous,[kind]:kind==='context_size'?Number(value):value});chatPreferences.set(S.selected,next);S.error='';render();if(kind==='context_size')void loadChatContext();void saveChatPreference(S.selected,next);}catch(error){setError(error);}
}
function reviewChatModel(value){
 if(!usable()||S.busy||archived()||!S.pip)return;
 let choice;try{choice=modelChoice(value,S.models,subscriptionChoices(personalPip()),routerOffer(),savedProviders());}catch(error){setError(error);return;}
 S.composerPanel='';const current=S.pip.model_choice||{mode:'default'};if(JSON.stringify(choice)===JSON.stringify(current)){render();return;}
 if(personalPip()){const name=choice.mode==='provider'?`${choice.model} on ${providerOf(choice.provider)?.name||'that provider'}`:choice.mode==='model'?(S.models.find(m=>m.id===choice.model)?.name||choice.model):choice.mode==='subscription'?modelLabel(choice):choice.mode==='router'?routerLabel(choice):'the same model as DGC',usage=usageLine(modelValue(choice));void applyOwnChange({model_choice:choice},d=>JSON.stringify(d.model_choice)===JSON.stringify(choice),`${S.pip.name} now uses ${name}.${usage?' '+usage:''}`);return;}
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
// A change waiting for you, as a card: what it wants in a sentence, what exactly as chips, Allow and Not now, and every
// value one click away (media/shared/card.js; the words are pipChangeCard.js). Allow accepts it right here, with the
// request and the checks the review page makes; the page itself is one more click, from Details.
const changeErrors=new Map();
function changeCardMarkup(p,where='chat'){
 const c=changeCard(p,S.pip),off=S.busy||!usable(),id=esc(p.id),stale=p.expected_version!==S.pip.current_version;
 const others=waitingProposals().filter(v=>v.id!==p.id&&v.expected_version===p.expected_version).length;
 return DgcCard.html({id:`${where}-${p.id}`,label:'Change waiting for you',attrs:{'data-change-card':p.id,'data-kinds':c.kinds.join(' ')},icon:c.icon,title:c.title,sub:c.sub,chips:c.chips,
  note:stale?'':others===1?'Allowing this sets the other waiting change aside. It is not approved.':others>1?`Allowing this sets the ${others} other waiting changes aside. They are not approved.`:'',
  // A change written for an older version of this Pip can't be accepted: the review page says so too, in these words.
  error:changeErrors.get(p.id)||(stale?STALE_CHANGE:''),
  actions:[{label:S.busy&&S.changeAllowing===p.id?'Allowing…':'Allow',primary:true,attrs:{'data-change-allow':p.id,id:`change-allow-${where}-${p.id}`},disabled:off||stale},
   {label:'Not now',attrs:{'data-reject':p.id,id:`change-reject-${where}-${p.id}`},disabled:off}],
  details:{rows:c.rows,link:{label:'Open the full review',attrs:{'data-proposal':p.id,id:`change-review-${where}-${p.id}`,...(off?{disabled:true}:{})}}}});
}
const STALE_CHANGE='This was written for an older version of this Pip. Turn it down and ask again.';
function chatSetupCards(){
 // Every change waiting for the user shows here, whoever saved it: the Pip, the main chat or an older build.
 return waitingProposals().map(p=>changeCardMarkup(p)).join('');
}
// Above every other tab: what is waiting, as the same cards.
function waitingMarkup(){
 const waiting=waitingProposals();if(!waiting.length||archived())return '';
 return `<section class="waiting" aria-label="Changes waiting for you"><h3>${waiting.length===1?'A change is waiting for you':`${waiting.length} changes are waiting for you`}</h3>${waiting.map(p=>changeCardMarkup(p,'tab')).join('')}</section>`;
}
// Sending with no provider, or its model's name missing: the same words and link as Work's.
// A turn DGC sent itself (a new Pip's hello, a follow-up) has no bubble, so when it fails nothing was said at all: a new Pip
// whose key the provider refused opened as an empty chat (upgrade check, 2026-11-07). It says so where the turn fell, as a
// failed message does; a hello that was the only thing in the chat offers Try again. A turn that ended with a post or a
// reply says it there, and it says so only while nothing has been said since: a hello that worked on Try again has no
// old failure above it.
function failedHidden(m){return m.role==='user'&&m.intro===true&&m.status==='failed'&&typeof m.error==='string'&&!!m.error&&S.messages.at(-1)?.id===m.id&&!S.messages.some(r=>r.role==='assistant'&&r.run_id===m.run_id)&&!S.posts?.some?.(p=>p.run_id===m.run_id);}
function failedHiddenMarkup(m){
 const failed=window.DgcMarkdown?.modelFailure?.(m.error),raw=typeof m.error_detail==='string'&&m.error_detail?(window.DgcMarkdown?.editorAdvice?.(m.error_detail)??m.error_detail):failed?.detail;
 const onlyHello=S.messages.every(x=>x.role==='user'&&x.intro===true&&x.status==='failed')&&!S.chatActiveRun;
 const again=onlyHello&&S.apiVersion>=43&&!remoteHost?` <button type="button" class="message-send-again" data-hello-again${S.busy||!usable()||!S.runner?.online?' disabled':''}>Try again</button>`:'';
 return `<div class="pip-failed-turn" data-failed-turn="${esc(m.id)}"><p class="message-status" role="alert" data-status="failed">Failed · ${esc(failed?`${failed.headline} ${failed.next}`:m.error)}${failed?.fix?` <button type="button" class="message-send-again" data-open-models>Settings → Models</button>`:''}${again}</p>${failed?`<details class="message-failure" data-details="failure-${esc(m.id)}"><summary>Details</summary><span>${esc(raw)}</span></details>`:''}</div>`;
}
async function helloAgain(){
 const pip=S.selected;if(!pip||S.busy||!usable())return;
 const token=scope();S.busy=true;render();
 try{const said=await send('introduce_pip',{pip_id:pip});if(token!==scope())return;if(said?.no_provider===true)S.noProvider=true;}
 catch(error){if(token===scope())setError(error);}
 finally{if(token===scope()){S.busy=false;render();void loadMessages();}}
}
function noProviderMarkup(){if(!S.noProvider||!S.noProviderSaid)return '';const w=window.DgcMarkdown?.modelWords?.('no_provider');return w?`<p class="message-status" role="alert" data-status="failed">${esc(w.headline)} ${esc(w.next)} <button type="button" class="message-send-again" data-open-models>Settings → Models</button></p>`:'';}
function renderPipMarkdown(text){return window.DgcMarkdown?.render?window.DgcMarkdown.render(text):`<div class="chat-text">${esc(text)}</div>`;}
// The Pip's own reply in its chat: the one place on this page a ```dgc-ui card is live. Its routine posts, run
// reports and fixes keep it as code (renderPipMarkdown).
function renderPipReply(text){return window.DgcMarkdown?.render?window.DgcMarkdown.render(text,{cards:true,previews:true}):`<div class="chat-text">${esc(text)}</div>`;}
document.addEventListener('click',event=>{
  const button=event.target?.closest?.('button.genui-send');
  if(!button||!button.closest('.pip-app-root .pip-message.assistant:not(.routine-reply) .message-body'))return;
  const text=String(button.dataset.genuiSend||'').slice(0,500);
  if(!text||!S.selected)return;
  if(pendingImages().length||pendingFiles().length){setError('Remove attachments before sending a card choice.');return;}
  rememberMarks();
  const saved=draft.chatText;
  draft.chatText=text;
  void sendChat();
  if(S.sending?.text===text){draft.chatText=saved;chatDrafts.set(S.selected,saved);rememberView();render();}
  else draft.chatText=saved;
});
// Core's catalog entry is "unavailable" (it cannot be made as a background Pip), but a Personal Core is
// the user's Primary Pip and takes messages like any Pip: battle test 4 found its chat could never send.
function takesMessages(){return !!(pipType(S.pip,S.types)?.available||personalPip()&&S.pip?.pip_type==='core');}
// The working row, as DGC's: who, what it is doing ("Thinking", "Loading the model", a tool's verb,
// "Writing"), then (time · ↓ tokens). The clock ticks in place (workingClock), without a render.
let workingVerbKey='',workingVerbAt=0;
// Its computer holds something from this run, on a card: its own "Waiting for the model" reads as if the model were the
// holdup. (The other cards come when a reply ends. A card from an earlier reply says nothing about what this run is doing.)
function cardWaitsForYou(){
 const run=S.chatActiveRun?.id,computer=computerState.pip===S.selected?computerState.value:null;
 return !!run&&Array.isArray(computer?.actions)&&computer.actions.some(a=>a.status==='pending'&&a.run_id===run);
}
function runDoing(act){return (!act||act.state==='waiting')&&cardWaitsForYou()?'Waiting for you':act?act.label:'';}
function workingWords(sending){
  const name=esc(S.pip.name),run=S.chatActiveRun,act=S.stream?.runId===run?.id?S.stream?.activity:null;
  if(!S.runner?.online)return `<span>${name} will answer when your Pips are running</span>`;
  if(sending||run?.status==='queued'||!run)return `<span>${name} is getting ready</span>`;
  const since=Date.parse(run.started_at||run.created_at),chars=S.stream?.runId===run.id?S.stream.text.length:0;
  const label=runDoing(act)||'Working',key=`${S.pip.id}:${run.id}:${label}`;
  if(key!==workingVerbKey){workingVerbKey=key;workingVerbAt=Date.now();}
  const delay=600-(Date.now()-workingVerbAt);
  return `<span class="pip-working-verb" style="--shimmer-delay:${Math.round(delay)}ms">${name} · ${esc(label)}</span>${Number.isFinite(since)?`<span class="pip-working-meta" data-since="${since}" data-chars="${chars}">${workingMeta(since,chars)}</span>`:''}`;
}
function workingMeta(since,chars){return `(${Math.max(0,Math.floor((Date.now()-since)/1000))}s · ↓ ${Math.round(chars/4)} tok)`;}
const workingClock=window.setInterval(()=>{for(const el of document.querySelectorAll('.pip-working-meta'))el.textContent=workingMeta(Number(el.dataset.since),Number(el.dataset.chars));
  for(const el of document.querySelectorAll('.run-post-clock[data-since]'))el.textContent=elapsed(Date.now()-Number(el.dataset.since));},1000);
// Messaging feel (pips-17c). Reply on a Pip's message (Pips API 83): the message becomes a quote in the prompt box, the
// shown conversation's own (chatReplies is one of convMaps), and goes with what you send next as `reply_to`.
function canReply(){return S.apiVersion>=83&&!remoteHost&&personalPip()&&!archived()&&usable();}
function pendingReply(){return canReply()?chatReplies.get(S.selected)||null:null;}
function replyChipMarkup(){
 const reply=pendingReply(),P=globalThis.DgcComposer;if(!reply||!P)return '';
 const words=String(reply.text).replace(/^\s*---\s*$/gm,' ').replace(/\s+/g,' ').trim(),who=S.pip?.name||'this Pip';
 return `<div class="chat-reply-row" role="group" aria-label="Replying to ${esc(who)}’s message">${P.pillHtml({classes:'chat-reply',title:`Replying to ${who}: ${words.slice(0,600)}`,thumbText:'\u21aa',thumbClass:'chat-reply-mark',name:words.slice(0,200),nameClass:'chat-reply-text',removeAttrs:`data-reply-remove="${esc(reply.id)}"`,removeLabel:'Remove the quote',removeTitle:'Remove the quote'})}</div>`;
}
// The quote line above a message. Your own: the Pip's message you replied to. A reply's: the message it answers, only
// when that isn't the message of yours just above it (you sent another while it worked) and it is on the page.
function quoteFor(m,shown){
 if(m.role==='user')return record(m.reply_to)&&typeof m.reply_to.text==='string'?m.reply_to.text:'';
 if(typeof m.answers!=='string'||!m.answers)return '';
 const at=shown.findIndex(x=>x.id===m.id),asked=shown.find(x=>x.id===m.answers&&x.role==='user'&&x.intro!==true);
 if(at<0||!asked)return '';
 for(let i=at-1;i>=0;i--)if(shown[i].role==='user'&&shown[i].intro!==true)return shown[i].id===asked.id?'':asked.text;
 return '';
}
function chatMarkup(){
  const type=pipType(S.pip,S.types),busy=S.chatActiveRun,canSend=(S.apiVersion<24||!!S.chatControls)&&!archived()&&S.messagesLoaded&&usable()&&takesMessages()&&supportedSource()&&S.runner?.online&&!S.runner?.paused&&!S.busy&&(!busy||S.apiVersion>=73);
  const markdown=renderPipMarkdown;
  const sending=S.sending&&S.sending.pip===S.selected&&(S.sending.conv||'')===S.conv&&!S.chatWaiting.some(m=>m.text===S.sending.text)&&!S.messages.some(m=>m.role==='user'&&m.text===S.sending.text&&Date.parse(m.created_at)>=Date.parse(S.sending.at)-60000)?S.sending:null;
  // A routine's failed run keeps its line where it fell, and the same line again is one line with a count (Pips package 2).
  const routineFailed=m=>failedRoutine(m,S.messages,S.posts,postRoutineTitle);
  const conv=convOn(),checking=conv&&!!S.chatActiveRun&&S.messages.some(m=>m.role==='user'&&m.intro===true&&m.run_id===S.chatActiveRun.id&&AGENT_CHECK.test(m.text||''));
  const shown=[...foldRoutineLines(S.messages.filter(m=>!agentCheckReply(m)).filter(m=>!(m.role==='user'&&m.intro===true)||failedHidden(m)||routineFailed(m)),S.messages,postRoutineTitle),...(sending?[{id:'sending',pip_id:S.selected,workspace_id:S.workspace?.id,role:'user',text:sending.text,status:'sending',created_at:sending.at,...(sending.marks?.length?{display_mentions:sending.marks}:{}),...(sending.reply?{reply_to:sending.reply}:{})}]:[])];
  // While it answers, the Pip itself is in the chat, at work, with its name: the reply replaces it.
  // A routine's run is its live post (liveMarkup), not the working row: what it is doing, its clock, Stop, how it started.
  const routineLive=!!(S.live?.routine&&S.chatActiveRun&&S.live.runId===S.chatActiveRun.id);
  const simple=chatStyle(),typing=!routineLive&&(busy||sending)&&(simple||S.messages.some(m=>m.role==='user'&&m.intro===true&&m.run_id===S.chatActiveRun?.id))&&(simple||!S.stream?.text)
   ?(simple?`<div class="pip-working" role="status">${pipAvatar(S.pip,'working',`working-${S.pip.id}`,type||characterType(S.pip.pip_type))}${workingWords(sending)}</div>`
    :`<article class="pip-message assistant typing" aria-label="${esc(S.pip.name)} is writing"><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span></article>`):'';
  let last=null;
  // A run's message has its own time beside the Pip's name: it moves the clock on without a mark of its own.
  const timed=(m,mark=true)=>{const at=Date.parse(m.created_at),line=mark&&simple&&Number.isFinite(at)&&(last===null||at-last>30*60*1000)?`<p class="chat-time">${esc(chatTime(at))}</p>`:'';if(Number.isFinite(at))last=at;return line;};
  const latest=S.messages.at(-1),answerable=latest&&latest.role==='assistant'&&Array.isArray(latest.choices)?latest:null;
  const drawMessage=m=>{
    if(routineFailed(m)){const failed=window.DgcMarkdown?.modelFailure?.(m.error);return timed(m,false)+failedRoutineMarkup(m,postRoutineTitle(m.text),{failure:failed,detail:typeof m.error_detail==='string'&&m.error_detail?(window.DgcMarkdown?.editorAdvice?.(m.error_detail)??m.error_detail):failed?.detail||''});}
    if(failedHidden(m))return timed(m,false)+failedHiddenMarkup(m);
    const prompt=S.messages.find(p=>p.role==='user'&&p.run_id===m.run_id),routine=m.role==='assistant'&&prompt?.intro===true?postRoutineTitle(prompt.text):null;
    if(routine&&m.quiet===true)return timed(m,false)+quietLineMarkup(m,routine);
    return timed(m,!routine)+messageMarkup(m,{imageSrc:messageImageSrc,pluginLogo:pluginLogoSrc,split:simple,name:S.pip?.name||type?.name||'Pip',formatDate:date,renderMarkdown:routine?markdown:renderPipReply,canSend,prompt,quote:quoteFor(m,shown),canReply:canReply(),canDownload:S.apiVersion>=43&&!remoteHost,activity:chatActivities.get(m.run_id),choices:m===answerable?m.choices:null,stats:m.role==='assistant'?replyStats.get(m.run_id):null,undo:canUndoOwn(),openChanges:ownDetailsOpen,undoing:ownUndoing,undoErrors:ownUndoErrors,...(routine?routineReply(m,routine,type):{})})+memoryKept(m,shown);
  };
  // Its runs, each a message from the Pip where it falls among the messages, all-clear runs in a row as one (Pips API
  // 51, pipRunPosts.js).
  const items=withNotes(chatPosts()?timeline(shown,S.posts,{complete:!S.messageCursor}):shown.map(m=>({message:m})),S.routineNotes||[],
    {complete:!S.messageCursor,timeOf:i=>Date.parse(i.message?i.message.created_at:(i.streak?i.streak.at(-1):i.post)?.posted_at)||0});
  const context=chatPosts()?postContext():null;
  const settled=settledLines(shown);
  const drawPost=i=>{const p=i.streak?i.streak.at(-1):i.post,first=i.streak?i.streak[0]:p;
    return timed({created_at:p.posted_at},false)+postMarkup(p,{...context,previous:i.previous,streak:i.streak||null,face:pipAvatar(S.pip,['failed','checks_failed'].includes(p.outcome)?'failure':'idle',`post-${first.run_id}`,context.type),...fixState(p.run_id),expanded:shownInFull.has(p.run_id),traced:replyStats.get(p.run_id)?.has_trace===true,...(flowCards()&&!i.streak?{under:flowUnderPost(p)}:{})});};
  // Each prompt opens a box, the rest of its turn inside: the box's end is what pushes a pinned prompt off (pipsFollow.js).
  // What a Pip says by itself (a run's post, a routine's reply) isn't an answer to it, so the box ends there.
  let turnOpen=false,pipRun=false;
  // A conversation (Pips API 97): the Pip's reply is Work's prose, with its face, name and time once per run of its messages.
  const plainReply=(html,m,lead)=>{const open=`class="pip-message msg assistant dgc`;if(!html.includes(open))return html;
   const led=lead&&!html.includes('run-post-head'),head=led?`<div class="run-post-head"><span class="run-post-face" aria-hidden="true">${pipAvatar(S.pip,'idle',`said-${m.id}`,type||characterType(S.pip.pip_type))}</span><strong class="run-post-name">${esc(S.pip.name)}</strong>${globalThis.DgcTime?.markup(Date.parse(m.created_at))||''}</div>`:'';
   const out=html.replace(open,`${open} pip-plain${led?' pip-led':''}`);return led?out.replace(`data-message="${esc(m.id)}">`,`data-message="${esc(m.id)}">${head}`):out;};
  const unasked=i=>!i.message||(i.message.role==='assistant'&&S.messages.find(p=>p.role==='user'&&p.run_id===i.message.run_id)?.intro===true&&!!postRoutineTitle(S.messages.find(p=>p.role==='user'&&p.run_id===i.message.run_id).text));
  const messages=items.map(i=>{
   if(i.note){const closes=turnOpen?'</div>':'';turnOpen=false;return closes+timed({created_at:i.note.at},false)+noteMarkup(i.note);}
   const own=i.message?.role==='assistant'&&!failedHidden(i.message)&&!routineFailed(i.message);
   const piece=(i.message?(conv&&own?plainReply(drawMessage(i.message),i.message,!pipRun):drawMessage(i.message)):drawPost(i))+(i.message?settled.byMessage.get(i.message.id)||'':settled.byRun.get((i.streak?i.streak.at(-1):i.post)?.run_id)||'');
   pipRun=own||!i.message;
   if(i.message&&(failedHidden(i.message)||routineFailed(i.message))){const closes=turnOpen?'</div>':'';turnOpen=false;return closes+piece;}
   if(i.message?.role==='user'){const opens=`${turnOpen?'</div>':''}<div class="pip-turn" data-turn="${esc(i.message.id)}">`;turnOpen=true;return opens+piece;}
   if(turnOpen&&unasked(i)){turnOpen=false;return '</div>'+piece;}
   return piece;
  }).join('');
  // A run going now: its live post, at the end, where its own post will stand when it ends.
  const live=liveMarkup(markdown);
  // A hello that failed says so, above what a new chat says about itself: nothing else has been said.
  const quietChat=S.messages.every(m=>m.role==='user'&&m.intro===true&&m.status==='failed')&&!items.some(i=>!(i.message&&failedHidden(i.message)))&&!live&&!items.some(i=>i.note||(i.message&&routineFailed(i.message)));
  return `<section class="pip-conversation${simple?' chat-style':''}${conv?' conv-look':''}" aria-label="Pip conversation">${flowPinnedMarkup()}<div class="conversation-log" role="log" aria-live="polite">${noProviderMarkup()}${errorMarkup(S.error)}${S.notice?`<p class="notice" role="status">${esc(S.notice)}</p>`:''}${(S.messageCursor&&S.messages.length<200)||(chatPosts()&&S.postsCursor&&!S.messageCursor)?button('older-messages','Load earlier messages',S.messagesLoading||S.postsLoading||!usable()):''}${S.messages.length>=200?'<p class="muted">Showing the latest 200 loaded messages. Earlier messages remain saved.</p>':''}${S.messagesError?errorMarkup(S.messagesError):''}${!S.messagesLoaded?'<p role="status" class="muted">Loading conversation…</p>':quietChat?`${messages}<div class="conversation-empty"><h3>Talk to ${esc(type?.name||'this Pip')}</h3><p class="muted">${personalPip()?'Talk about your plans, ask questions, or share details to work with.':'Ask about '+(currentTree()?'your current files':'the committed code')+' in this project.'} ${esc(S.pip.name)} keeps this chat.</p><p class="muted">${personalPip()?'It sees only what you share here. To use an app like Gmail, ask it to connect one.':type?esc(type.description):'Unsupported Pip type.'}</p></div>`:''}${quietChat?'':messages}${live}${simple?'':typing}${S.stream?.text&&!routineLive&&!checking?`<article class="pip-message assistant dgc provisional" aria-label="Live reply preview"><span class="sr-only">${esc(type?.name||'Pip')}</span>${simple?'':'<p class="message-status">Still writing…</p>'}${simple?`<div class="answer split">${replyParts(S.stream.text).map(part=>`<div class="message-body text reply-part">${markdown(part)}</div>`).join('')}</div>`:`<div class="message-body text">${markdown(replyParts(S.stream.text).join('\n\n'))}</div>`}${S.stream.limited?'<p class="muted">Showing the start of the reply. The whole reply appears when it’s done.</p>':''}</article>`:''}${S.stream?.error?`<p class="muted">${esc(S.stream.error)}</p>`:''}${simple?typing:''}${learnCard()}${chatResultCards()}${chatSetupCards()}${emailDraftCards()}${appLinkCards()}${pluginCards()}${pipKeyCards()}${borrowCards()}${projectChangeCards()}${flowTailMarkup()}${routineCards()}${settled.tail}${needsYouCard()}${cardRefusedCard()}${turnOpen?'</div>':''}${S.omitted?`<p class="context-limit">${esc(S.pip.name)} no longer sees your ${S.omitted===1?'earliest message':S.omitted+' earliest messages'}. ${S.omitted===1?'It’s':'They’re'} still saved here.</p>`:''}</div><button type="button" id="pip-to-latest" class="pip-to-latest" data-dom-own="1" title="Jump to the newest message" aria-label="Jump to the newest message" hidden><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v10M4 9l4 4 4-4"/></svg><span data-latest-label>Latest</span></button>${simple?runnerOffMarkup():''}${pipOff(S.pip)?`<p class="pip-off-line" role="status">${PIP_OFF_SAYS}</p>`:''}<div class="pip-composer-shell">${routinePopoverMarkup()}${computerWaitingCards()}${needsComputerCard()}${goalCard()}<div id="chat-tray" class="rail-line tray-only" data-dom-own="1"></div><form id="chat-form" class="pip-composer tray-box"><div class="dgc-drop" data-dom-own hidden aria-hidden="true">Drop to attach</div>${replyChipMarkup()}${canAttachImages()?imageStripMarkup():''}${chatBox?'<div id="chat-pop" class="pop pop-over" data-dom-own="1"></div>':''}<div class="composer-input">${chatBox?'<div id="chatText" class="mention-box" data-dom-own="1"></div>':`<label class="sr-only" for="chatText">Message ${esc(type?.name||'this Pip')}</label><textarea id="chatText" data-draft="chatText" rows="1" placeholder="${simple?`Ask ${esc(S.pip.name)}`:`Message ${esc(type?.name||'this Pip')}…`}" maxlength="${CHAT_MAX_CHARS}"${archived()||!usable()?' disabled':''}>${esc(draft.chatText)}</textarea>`}</div>${chatControlsMarkup(canSend,busy)}</form></div><p class="composer-hint">${pagePip()?[archived()?'Archived. Restore it in Settings to chat again.':'',!S.runner?.online?'Start Pips to send a message.':S.runner?.paused?'Resume Pips to send a message.':''].filter(Boolean).join(' '):`${archived()?'Archived · Restore to paused before sending another message. ':''}${(currentTree()?'Your current files':'Committed code')+' · reads only'}${!S.runner?.online?' · Start Pips to send a message.':S.runner?.paused?' · Resume Pips to send a message.':''}`}</p></section>`;
}
// ---- Its runs in its chat (Pips API 51) ----
// Each finished run is a post from the Pip, read with list_pip_run_posts and drawn among the messages; History
// (was Runs) uses the same posts to say what each run found, and the status under its name jumps to the latest.
function postsShown(){return S.apiVersion>=51&&!remoteHost;}
function postFor(runId){return S.posts.find(p=>p.run_id===runId)||null;}
// Ask DGC to fix goes to a Work chat, which only the host can reach: the chat the Pip reports to, else a new one.
function canAskDgc(){return typeof options.onAskDgc==='function'&&!remoteHost&&!personalPip()&&!onePips();}
// One Pips: a check's findings are a card under its post, with what became of them (src/pipFlow.js).
function flowCards(){return onePips()&&!!S.pip&&!personalPip();}
function canRunNow(){return supportedSource()&&(!executionPip(S.pip)||livePip(S.pip)&&S.apiVersion>=60)&&S.runner?.online&&!S.runner.paused&&S.pip?.status==='active'&&!!pipType(S.pip,S.types)?.available&&!S.pip.active_run&&!S.runs.some(r=>active(r.status))&&!S.busy&&usable();}
// ---- A run while it runs: its live post (reported 24 Oct; pipRunPosts.js livePostMarkup) ----
// From the moment a run starts, its chat has one post for it at the end: the Pip at work, what it is doing now (the run's
// activity, read every 1.5 s while the chat is on screen), a clock, Stop, and how it started. When the run ends, its
// own post (list_pip_run_posts) takes that place. All of it is read from the run -- get_pip's active run, list_pip_runs,
// get_pip_run and its activity -- so a reload while it runs draws it again. A routine's run (a hidden turn in a
// Personal Pip's chat) is one too, in place of the working row, and its reply takes its place.
S.live=null;let liveSeq=0,liveTimer=0,liveLoading=false;
// Runs that post in the chat when they end (dgc/pip_run_posts.py build): a source review, a live-data run, a Pulse's own
// checks, a Quill draft and a Personal Pip's task. A chat reply has its working row; Patch work and a handoff's test run
// are reviewed where they were handed off.
function postingRun(run){const kind=run?.run_kind||run?.manifest?.run_kind||'audit';return ['audit','live','draft','personal_task'].includes(kind)||kind==='test'&&run.execution_mode==='standalone_plan';}
function liveCandidate(){
  let a=S.pip?.active_run;
  if(!postsShown()||!record(a))return null;
  // A reply in its chat while one of its runs goes on: get_pip names one active run, its run list the rest.
  if(a.run_kind==='conversation')a=S.runs.find(r=>active(r.status)&&(r.manifest?.run_kind||'audit')!=='conversation');
  if(!record(a)||typeof a.id!=='string'||!/^run_[0-9a-f]{32}$/.test(a.id)||!active(a.status))return null;
  const run={...(S.runs.find(r=>r.id===a.id)||{}),...a};
  return postingRun(run)?run:null;
}
// "First run": its setup card's run, queued as the card made the Pip -- its only run, started with the Pip itself. A Run
// now pressed later on a Pip that never ran is "Started by you".
function firstRun(run){
  const made=Date.parse(S.pip?.created_at||''),queued=Date.parse(run.created_at||'');
  return S.runs.length<40&&['manual',undefined].includes(run.manifest?.trigger)&&Number.isFinite(made)&&Number.isFinite(queued)&&Math.abs(queued-made)<10000
    &&!S.runs.some(r=>r.id!==run.id&&(r.manifest?.run_kind||'audit')!=='conversation');
}
function dropLive(){liveSeq++;window.clearTimeout(liveTimer);liveTimer=0;liveLoading=false;S.live=null;}
function syncLive(){
  if(S.live?.routine)return;                      // a routine's live post follows its chat (syncRoutineLive)
  const run=liveCandidate();
  if(run){
    if(S.live?.runId!==run.id||S.live.pipId!==S.selected){dropLive();S.live={runId:run.id,pipId:S.selected,routine:'',run,detail:null,activity:null,cursor:0,state:'running',stopping:false,first:firstRun(run),endSeq:0};void loadLive();}
    else{S.live.run={...S.live.run,...run};if(S.live.state==='ending')S.live.state='running';if(!liveTimer&&!liveLoading)scheduleLive();}
    return;
  }
  if(!S.live||S.live.state==='ending')return;
  // It ended: its post is read next (loadSelected reads the posts right after this), and takes its place. Until then
  // the live post says it is finishing, so nothing jumps; a run that posts nothing (you stopped it) just goes.
  if(!postsShown()){dropLive();return;}
  window.clearTimeout(liveTimer);liveTimer=0;S.live.state='ending';S.live.endSeq=postsSeq+1;
  const id=S.live.runId;window.setTimeout(()=>{if(S.live?.runId===id&&S.live.state==='ending'){settleLive();render();}},10000);
}
function settleLive(){
  const live=S.live;if(!live)return;
  if(!postFor(live.runId)&&live.stopping)S.notice=`Stopped. ${S.pip?.name||'The Pip'} posts nothing for a run you stop.`;
  dropLive();
}
function syncRoutineLive(){
  const run=S.chatActiveRun,hidden=run&&postsShown()?S.messages.find(m=>m.role==='user'&&m.intro===true&&m.run_id===run.id):null,title=hidden?postRoutineTitle(hidden.text):null;
  if(title){
    if(S.live?.runId!==run.id){dropLive();S.live={runId:run.id,pipId:S.selected,routine:title,run,started:routineStartedWords(hidden.text,hidden.created_at),state:'running',stopping:false};}
    else S.live.run=run;
    return;
  }
  if(S.live?.routine)dropLive();                  // its reply is in the chat now, in its place
}
function scheduleLive(){
  window.clearTimeout(liveTimer);liveTimer=0;
  if(S.live&&!S.live.routine&&S.live.state!=='ending'&&S.tab==='chat'&&S.visible&&!document.hidden)liveTimer=window.setTimeout(()=>{liveTimer=0;void loadLive();},1500);
}
// The run in full once (when it was due, what started it), then its activity, on from where the last look stopped.
async function loadLive(){
  const live=S.live;if(!live||live.routine||liveLoading||!usable())return;
  window.clearTimeout(liveTimer);liveTimer=0;
  const token=scope(),seq=liveSeq,id=live.runId;liveLoading=true;let ended=false,changed=false;
  try{
    if(!live.detail){const v=await send('get_pip_run',{run_id:id});if(token!==scope()||seq!==liveSeq)return;
      if(record(v?.run)&&v.run.id===id&&v.run.pip_id===S.selected){live.detail=v.run;changed=true;if(!active(v.run.status))ended=true;}}
    for(let page=0;page<4&&!ended;page++){
      const after=live.cursor,v=activityPage(await send('list_pip_run_activity',{run_id:id,after}),{id,pip_id:S.selected,workspace_id:S.workspace.id},after);
      if(token!==scope()||seq!==liveSeq)return;
      live.cursor=v.next_cursor;const next=latestActivity(v.events,live.activity);if(next!==live.activity){live.activity=next;changed=true;}
      if(activityEnded(v.events))ended=true;
      if(!v.has_more)break;
    }
  }catch{/* the post keeps what it said; the next look reads it again */}
  finally{if(seq===liveSeq){liveLoading=false;if(token===scope()){if(changed)render();if(ended)void loadSelected(false);else scheduleLive();}}}
}
async function stopLive(runId){
  const live=S.live;if(!live||live.runId!==runId||live.stopping||live.state==='ending'||!usable())return;
  live.stopping=true;render();
  try{await send('cancel_pip_run',{run_id:runId});if(S.live===live){if(live.routine)void loadMessages();else void loadSelected(false);}}
  catch(error){if(S.live===live){live.stopping=false;setError(error);}}
}
function liveMarkup(markdown){
  const live=S.live;if(!live||live.pipId!==S.selected||!S.pip)return '';
  if(!live.routine&&S.conv)return '';   // a run's live post stands where its post will: in its first conversation
  const type=pipType(S.pip,S.types)||characterType(S.pip.pip_type);
  if(live.routine){
    const run=S.chatActiveRun?.id===live.runId?S.chatActiveRun:live.run,act=S.stream?.runId===live.runId?S.stream.activity:null,text=S.stream?.runId===live.runId?S.stream.text:'';
    const state=live.stopping||run?.status==='cancelling'?'stopping':run?.status==='queued'?'queued':'running';
    return livePostMarkup({runId:live.runId,name:S.pip.name,face:pipAvatar(S.pip,state==="queued"?"idle":"working",`post-${live.runId}`,type),routine:live.routine,
      doing:!S.runner?.online?['Waiting for Pips to start']:state==='queued'?['Waiting to start']:runDoing(act)?[runDoing(act)]:['Getting started'],since:Date.parse(run?.started_at||''),state,started:live.started,
      body:text?`<div class="run-post-reply">${markdown(replyParts(text).join('\n\n'))}</div>`:''});
  }
  // Its state and start from the latest look (get_pip, list_pip_runs); from the full read only what never changes (when
  // it was due, what started it): read while it waited, that read has no start time.
  const now=S.pip.active_run?.id===live.runId?S.pip.active_run:{};
  const run={...(live.detail||{}),...live.run,manifest:{...(live.run.manifest||{}),...(live.detail?.manifest||{})},status:now.status||live.run.status,
    started_at:now.started_at||live.run.started_at||live.detail?.started_at||null};
  const state=live.state==='ending'?'ending':live.stopping||run.status==='cancelling'?'stopping':run.status==='queued'?'queued':'running';
  const pulse=pulseProgress({...run,command_progress:S.pip.active_run?.id===live.runId&&S.pip.active_run.command_progress||run.command_progress});
  const doing=!S.runner?.online&&state!=='ending'?['Waiting for Pips to start']:state==='queued'?['Waiting to start']:pulse?[`Checked ${pulse.passed+pulse.failed} of ${pulse.total}`]:live.activity||['Getting started'];
  return livePostMarkup({runId:live.runId,name:S.pip.name,face:pipAvatar(S.pip,state==="queued"?"idle":"working",`post-${live.runId}`,type),
    doing,since:Date.parse(run.started_at||''),state,started:startedWords(run,{first:live.first}),canStop:usable()});
}
// To a run in the chat: its live post while it runs, else its post.
async function jumpToRun(runId){
  const go=()=>{const el=document.querySelector(`[data-run-post="${runId}"]`)||document.querySelector(`[data-streak-run="${runId}"]`);if(!el)return false;el.closest('details')?.setAttribute('open','');revealInChat(el);el.focus?.({preventScroll:true});el.classList.add('run-post-flash');window.setTimeout(()=>el.classList.remove('run-post-flash'),1600);return true;};
  if(go())return;
  await Promise.all([loadMessages(),loadPosts()]);
  if(!go())openPostReport(runId);
}
// A routine's reply (pip_routines) is the Pip's own message, said without being asked: like a run's, it says who and
// which routine, and a long one starts short with Show all.
function routineReply(m,title,type){
  const cut=shortReply(m.text),look=type||characterType(S.pip.pip_type);
  const head=`<div class="run-post-head"><span class="run-post-face" aria-hidden="true">${pipAvatar(S.pip,'idle',`routine-${m.id}`,look)}</span><strong class="run-post-name">${esc(S.pip.name)}</strong><span class="run-post-routine">${esc(title)}</span>${globalThis.DgcTime?.markup(Date.parse(m.created_at))||''}</div>`;
  return {head,clip:cut.clipped?{text:cut.text,open:shownInFull.has(m.id),key:m.id}:null};
}
function postContext(){
  return {name:S.pip.name,type:pipType(S.pip,S.types)||characterType(S.pip.pip_type),personal:personalPip(),ask:canAskDgc(),canRun:canRunNow(),renderMarkdown:renderPipMarkdown,
    docs:S.apiVersion>=78&&!remoteHost,
    openFix:typeof options.onOpenFix==='function'&&!remoteHost};
}
// ---- What Ask DGC to fix did, in the run's post (Pips API 65) ----
// The fix runs in a Work chat and keeps its record on disk (dgc/pip_fix.py). The post reads it each time the posts are
// read: opening the Pip, every 4 seconds while its chat or History is on screen, and coming back into view. So it says
// fixing, Fixed, failed or undone as the Work chat's card does, live, and the same after a reload or a restart.
function fixesShown(){return S.apiVersion>=65&&postsShown()&&!personalPip()&&!onePips();}
function fixState(runId){
  if(!fixesShown())return {asked:askedRuns.has(runId)};
  const fix=S.fixesPip===S.selected?S.fixes.get(runId)||null:null,at=askingFix.get(runId);
  // Asked just now: "Asking DGC…" until its fix is read (one at work, or newer than the ask), for half a minute at most.
  const asking=at!==undefined&&Date.now()-at<30000&&!(fix&&(FIX_ACTIVE.includes(fix.state)||Number(fix.created_at)*1000>=at-2000));
  if(at!==undefined&&!asking)askingFix.delete(runId);
  return {fix,asking};
}
async function loadFixes(){
  if(!fixesShown()||!S.selected||!usable()||!S.posts.some(askable))return;
  const token=scope(),id=S.selected,sequence=++fixesSeq;
  try{const fixes=runFixesPage(await send('list_pip_run_fixes',{pip_id:id}),id,S.workspace.id);
    if(token!==scope()||sequence!==fixesSeq||S.selected!==id)return;
    const before=S.fixesPip===id?JSON.stringify([...S.fixes]):'';S.fixes=fixes;S.fixesPip=id;
    if(JSON.stringify([...fixes])!==before||askingFix.size)render();
  }catch{/* the post keeps what it said; the next look reads it again */}
}
// The fix's chip goes to the Work chat it ran in: its card there has Review, Undo, Watch and Stop.
function openFixChat(runId){
  const fix=S.fixes.get(runId);if(!fix?.session_id||typeof options.onOpenFix!=='function'||remoteHost)return;
  const result=options.onOpenFix({session:fix.session_id,run_id:runId});
  if(result!==true)setError(typeof result==='string'?result:'DGC could not open the Work chat this fix ran in.');
}
async function loadPosts(more=false){
  if(!postsShown()||!S.selected||!usable()||(more&&(!S.postsCursor||S.postsLoading)))return;
  const token=scope(),id=S.selected,sequence=++postsSeq,before=more?S.postsCursor:null;S.postsLoading=true;
  try{const page=runPostsPage(await send('list_pip_run_posts',{pip_id:id,limit:more?50:30,...(before?{before_id:before}:{})}),id,S.workspace.id);
    if(token!==scope()||sequence!==postsSeq||S.selected!==id)return;
    S.posts=mergePosts(S.postsPip===id?S.posts:[],page.posts);S.postsPip=id;
    if(more||!S.postsLoaded)S.postsCursor=page.next_before_id;S.postsLoaded=true;S.postsError='';
  }catch(error){if(token===scope()&&sequence===postsSeq)S.postsError=errorText(error);}
  finally{if(token===scope()&&sequence===postsSeq){S.postsLoading=false;if(S.live?.state==='ending'&&sequence>=S.live.endSeq)settleLive();render();maybeMarkRead();void loadFixes();void loadFlow();void loadReplyStats();}}
}
// Open full report: the run, under History, at its report.
function openPostReport(runId){S.tab='runs';S.overview=false;rememberView();render();void loadRun(runId).then(()=>document.querySelector('section[aria-label="Run report"],section[aria-label="Pulse command receipt"],section[aria-label="Documentation draft"]')?.scrollIntoView?.({block:'start'}));}
// The status under its name: to its post in the chat, which says what it found.
function jumpToPost(runId){
  S.tab='chat';S.overview=false;rememberView();render();
  const go=()=>{const el=document.querySelector(`[data-run-post="${runId}"]`)||document.querySelector(`[data-streak-run="${runId}"]`);if(!el)return false;el.closest('details')?.setAttribute('open','');revealInChat(el);el.focus?.({preventScroll:true});el.classList.add('run-post-flash');window.setTimeout(()=>el.classList.remove('run-post-flash'),1600);return true;};
  if(!go())void loadMessages().then(()=>{if(!go())openPostReport(runId);});
}
function askDgcAbout(runId){
  const post=postFor(runId);if(!post||!canAskDgc())return;
  const live=fixesShown(),{fix,asking}=live?fixState(runId):{};
  if(live?asking||FIX_ACTIVE.includes(fix?.state):askedRuns.has(runId))return;
  const result=options.onAskDgc({report:post,session:typeof S.pip?.report_session==='string'?S.pip.report_session:''});
  if(result!==true){setError(typeof result==='string'?result:'DGC could not reach the Work chat.');return;}
  // From Pips API 65 the post says what the fix does, read from DGC; before, that it was asked, kept with the view.
  if(live){askingFix.set(runId,Date.now());for(const ms of [1500,5000,12000])window.setTimeout(()=>void loadFixes(),ms);}
  else{askedRuns.add(runId);rememberView();}
  S.notice='Asked DGC in the Work chat.';render();
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
// Opening an empty chat starts the Pip's own first turn. The backend uses one reserved
// idempotency key and refuses a late hello once a person has already spoken; this local
// guard prevents the four-second refresh from repeatedly asking while that turn queues.
const firstOpenRequested=new Set();
async function introduceOnFirstOpen(id){
 if(firstOpenRequested.has(id)||S.noProvider||remoteHost||S.apiVersion<43||!S.runner?.online||S.runner.paused)return;
 firstOpenRequested.add(id);
 try{
  const said=await send('introduce_pip',{pip_id:id});
  // With no provider there's nothing to greet with yet (the host answers this itself): it greets on the next look after one is saved.
  if(said?.no_provider===true){firstOpenRequested.delete(id);S.noProvider=true;render();return;}
  if(S.selected===id&&S.tab==='chat')void loadMessages();
 }catch(error){
  if(S.selected===id){S.messagesError=`${S.pip?.name||'This Pip'} could not start its first message: ${errorText(error)}`;render();}
 }
}
async function loadMessages(more=false){
 if(!more){void loadFlow();void loadGoal();void loadConversations();void loadEmailDrafts();void loadAppLinks();void loadPlugins();void loadBorrows();void loadRoutines();void loadLevel();void loadNotes();void loadWorkingNotes();void loadDailyLog();void refreshComputer();if(personalPip()&&!S.models.length&&!S.defaultModel)void loadModels();}
  if(!S.selected||!usable()||(more&&(!S.messageCursor||S.messagesLoading||S.messages.length>=200)))return;
  const token=scope(),id=S.selected,sequence=++messageSeq,before=more?S.messageCursor:null,optionsEpoch=chatOptionsEpoch;S.messagesLoading=true;
  if(!S.messagesLoaded)render();
  let back=null;
  try{const page=messagesPage(await send('list_pip_messages',{pip_id:id,limit:20,...(before?{before_id:before}:{}),...convArg()}),id,S.workspace.id);if(token!==scope()||sequence!==messageSeq)return;if(S.apiVersion>=24){S.chatControls=null;S.chatControls=checkedChatControls(page.chat_controls);
    // Since API 47 DGC keeps the Pip's own window and thinking, so what it says wins over what this view remembered:
    // the main chat may have changed them. Not while this view is saving its own choice, or when a save overlapped.
    const kept=S.apiVersion>=47&&!remoteHost&&!before&&optionsEpoch===chatOptionsEpoch&&!chatOptionsSaving.has(id);
    if(!chatPreferences.has(id)||kept)chatPreferences.set(id,{...S.chatControls.options});if(!before)void loadChatContext();}
    if(more){if(page.next_before_id===before||page.messages.some(m=>S.messages.some(p=>p.id===m.id)))throw new Error('Conversation history did not advance. Refresh before retrying.');S.messages=[...page.messages,...S.messages].slice(-200);S.messageCursor=page.next_before_id;}
    else{const held=new Set([...S.messages.filter(m=>m.steer_status!=='missed').map(m=>m.id),...S.chatWaiting.map(m=>m.id)]);if(!S.messagesLoaded)S.messageCursor=page.next_before_id;S.messages=mergeChatPage(S.messages,page.messages).slice(-200);S.chatWaiting=page.waiting;if(!before){S.routineNotes=routineNotes(page.routine_notes);S.fallbackOn=fallbackOn(page.fallback_on);}
      // A mid-turn message the reply ended without reading wasn't sent, and comes back to an empty box, as in Work. Only as it happens, never on a reload.
      back=S.messages.find(m=>m.steer_status==='missed'&&held.has(m.id));}
    S.messagesLoaded=true;S.messagesError='';S.chatActiveRun=page.active_run;if(!more)lookAgainForWaitingTurn(page);if(back&&!draft.chatText.trim())giveBackToBox(id,back);queueMicrotask(()=>{if(!disposed)drainChatQueue();});S.omitted=page.history_context_omitted_count;S.continuity=chatContinuity(page.continuity,id,S.workspace.id);syncRoutineLive();
    if(!more&&S.tab==='chat'&&!S.conv&&!S.messages.length&&!page.active_run&&S.pip?.id===id&&S.pip.status==='active')void introduceOnFirstOpen(id);
    if(!more)voiceMode?.check(!!page.active_run);
    if(!page.active_run){streamSeq++;streamLoading=false;S.stream=null;}else if(!S.stream||S.stream.runId!==page.active_run.id){streamSeq++;streamLoading=false;S.stream={runId:page.active_run.id,cursor:0,text:'',limited:false,error:'',truncated:false};}
    if(page.active_run)void loadChatStream();
    if(!more)void loadReplyStats();
    if(!more)projectChangesDue(id,page);
  }catch(error){if(token===scope()&&sequence===messageSeq)S.messagesError=errorText(error);}
  finally{if(token===scope()&&sequence===messageSeq){S.messagesLoading=false;render();maybeMarkRead();}}
}
// A message waiting with no reply running has its turn starting this moment: see it start without waiting for the next poll.
let waitingLooks=0,waitingLook=0;
function lookAgainForWaitingTurn(page){
 if(!page.waiting.length||page.active_run){waitingLooks=0;return;}
 if(waitingLook||waitingLooks>=4)return;
 waitingLooks++;waitingLook=window.setTimeout(()=>{waitingLook=0;if(!disposed&&usable())void loadMessages();},400);
}
// What each reply took (list_pip_reply_stats, API 44): read once per finished reply, kept for the view.
const replyStats=new Map();let replyStatsSeq=0;
async function loadReplyStats(){
  if(remoteHost||S.apiVersion<44||!usable())return;
  const pip=S.selected,token=scope();
  const posted=postsShown()&&Array.isArray(S.posts)?S.posts.map(p=>p.run_id):[];   // a run's post has its Trace too
  const runs=[...new Set([...posted,...S.messages.filter(m=>m.role==='assistant'&&m.status==='succeeded').map(m=>m.run_id)].filter(r=>/^run_[a-f0-9]{32}$/.test(r||'')&&!replyStats.has(r)))].slice(-50);
  if(!runs.length)return;
  const sequence=++replyStatsSeq;
  try{const v=await send('list_pip_reply_stats',{pip_id:pip,run_ids:runs});if(token!==scope()||S.selected!==pip||sequence!==replyStatsSeq||!record(v)||v.pip_id!==pip||!Array.isArray(v.stats))return;
   for(const s of v.stats.slice(0,50))if(record(s)&&runs.includes(s.run_id)&&(s.seconds===null||Number.isFinite(s.seconds))&&[s.input_tokens,s.output_tokens,s.requests].every(n=>Number.isSafeInteger(n)&&n>=0))replyStats.set(s.run_id,s);
   render();}
  catch{/* the line is left out */}
}
// Its Trace: the steps are read when it's opened, one reply's at a time (list_pip_reply_stats with just its run).
async function openReplyTrace(run,model){
  const pip=S.selected,token=scope();
  let trace=null;
  try{
    const v=await send('list_pip_reply_stats',{pip_id:pip,run_ids:[run]});
    if(token!==scope()||S.selected!==pip)return;
    const item=record(v)&&Array.isArray(v.stats)?v.stats.find(s=>record(s)&&s.run_id===run):null;
    trace=globalThis.DgcTrace?.fromSaved(item?.trace,String(run).slice(0,10),model)||null;
  }catch{/* said below */}
  if(token!==scope()||S.selected!==pip)return;
  if(trace)globalThis.DgcTrace.open(trace);
  else{S.notice="This reply's trace couldn't be read.";render();}
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
      }else if(event.event_type==='pip_run_progress'&&event.payload.kind==='progress'&&typeof event.payload.state==='string'&&typeof event.payload.message==='string'&&event.payload.message){
        // Started again (dgc/pip_run_watchdog.py): what the stuck try had written goes; the new try writes its own.
        if(event.payload.state==='restarted'){S.stream.text='';S.stream.limited=false;}
        S.stream.activity={state:event.payload.state.slice(0,40),label:event.payload.message.slice(0,120)};
      }
      else if(/^pip_run_(succeeded|failed|cancelled)$/.test(event.event_type))ended=true;
    }
    S.stream.error='';if(!page.has_more||S.stream.limited)break;
  }}catch(error){if(token===scope()&&sequence===streamSeq&&S.stream){S.stream.error='The reply will appear when it’s done.';changed=true;}}
  finally{if(token===scope()&&sequence===streamSeq){streamLoading=false;if(changed)render();
    if(ended){void loadMessages();if(S.pip?.pip_type==='core')void loadSetups();} // Core may have prepared new Personal Pip reviews.
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
// The logos of the apps in "Apps it can use" that a Pip reaches through Composio, by toolkit id: the host finds each (src/pluginLogos.ts).
const appLogoCache=new Map(),appLogoAsked=new Set();
// Files go with a message too, as in the main chat: text and code, PDF, Word, Excel, PowerPoint,
// OpenDocument, RTF, CSV and TSV. Inline, up to 4 and 2 MB in all with any images; from API 52, the Work
// chat's limits: up to 16, a document up to 16 MB, a text or code file up to 1 MB, 32 MB in all.
const PIP_FILE_EXTENSIONS=['.pdf','.docx','.xlsx','.pptx','.odt','.ods','.odp','.rtf','.csv','.tsv','.txt','.md','.markdown','.rst','.log','.json','.jsonl','.yaml','.yml','.toml','.ini','.cfg','.conf','.xml','.html','.htm','.css','.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.rb','.go','.rs','.java','.kt','.swift','.c','.h','.cpp','.hpp','.cs','.php','.sh','.sql','.r','.ipynb','.srt','.vtt','.tex','.bib','.svg','.ics','.vcf','.eml'],PIP_MAX_FILES=4;
const chatFiles=new Map();
function pendingFiles(){return chatFiles.get(S.selected)||[];}
function fileExtension(name){const i=name.lastIndexOf('.');return i>0?name.slice(i).toLowerCase():'';}
function fileSize(n){return n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(n<10240?1:0)} KB`:`${(n/1048576).toFixed(1)} MB`;}
// Pictures and files go with a message to a Personal Pip (Pips API 43) and, from API 84, to a Project Pip too (as
// reference beside the code it reads) and while a reply is running (pips-08).
function canAttachImages(){return S.apiVersion>=43&&!remoteHost&&(personalPip()||S.apiVersion>=84);}
function attachesMidReply(){return S.apiVersion>=84;}
function spoolsPhotos(){return S.apiVersion>=52;}
// What one message may carry: from Pips API 79 (Limits for everyone, 10 Nov) 20 MB a photo, 50 files, 100 MB a
// document and 200 MB in all; an older runtime keeps API 52's.
function pipLimits(){const raised=S.apiVersion>=79;return {photo:raised?20*MB:PIP_PHOTO_BYTES,photos:raised?200*MB:PIP_PHOTOS_BYTES,files:raised?50:PIP_SPOOL_FILES,document:raised?100*MB:PIP_DOCUMENT_BYTES,filesBytes:raised?200*MB:PIP_FILES_BYTES,message:raised?200*MB:Infinity};}
function pendingImages(){return chatImages.get(S.selected)||[];}
function heicFile(f){return PIP_HEIC_TYPES.includes(String(f.type||'').toLowerCase())||!f.type&&['.heic','.heif'].includes(fileExtension(f.name||''));}
function imageStripMarkup(){
 const images=pendingImages(),files=pendingFiles();if(!images.length&&!files.length)return '';
 // An iPhone photo can't be drawn here (Chromium has no HEIC); its chip says what it is, and DGC sends it as a JPEG.
 // Each is the prompt box's shared pill (media/shared/composer.js), as in Work and ChatDGC; a picture opens large just
 // above the box (data-open-image), ✕ takes one away.
 const P=globalThis.DgcComposer,size=(n)=>`<span class="chat-file-size">${esc(fileSize(n))}</span>`;
 return `<div class="chat-images" aria-label="Images and files to send">${images.map((image,i)=>image.heic
  ?P.pillHtml({classes:'chat-file-chip chat-heic-chip',title:`${image.name}: an iPhone photo, sent as a JPEG`,thumbText:'heic',name:image.name,nameClass:'chat-file-name',after:size(image.bytes),removeAttrs:`data-remove-image="${i}"`,removeLabel:`Remove ${image.name}`})
  :P.pillHtml({classes:'chat-image-chip',title:image.name||`Image ${i+1}`,src:image.data,alt:`Image ${i+1} to send`,name:image.name||`Image ${i+1}`,openAttrs:`data-open-image="${i}"`,removeAttrs:`data-remove-image="${i}"`,removeLabel:`Remove image ${i+1}`})).join('')}${files.map((file,i)=>P.pillHtml({classes:'chat-file-chip',title:file.name,thumbText:(fileExtension(file.name).slice(1)||'txt').slice(0,4),name:file.name,nameClass:'chat-file-name',after:size(file.bytes),removeAttrs:`data-remove-file="${i}"`,removeLabel:`Remove ${file.name}`})).join('')}</div>`;
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
 const L=pipLimits(),mb=n=>`${Math.round(n/MB)} MB`;
 const takeImages=list.slice(0,Math.max(0,(spool?PIP_SPOOL_IMAGES:PIP_MAX_IMAGES)-images.length)),takeFiles=usable.slice(0,Math.max(0,(spool?L.files:PIP_MAX_FILES)-filesNow.length));
 if(spool){
  // The Work chat's limits, one plain sentence each.
  if(takeImages.length<list.length){setError(`Send up to ${PIP_SPOOL_IMAGES} photos with one message.`);return;}
  if(takeFiles.length<usable.length){setError(`Send up to ${L.files} files with one message.`);return;}
  const big=takeImages.find(f=>f.size>L.photo);if(big){setError(`${big.name||'That photo'} is over ${mb(L.photo)}; send a smaller photo.`);return;}
  const photoBytes=images.reduce((n,i)=>n+i.bytes,0)+takeImages.reduce((n,f)=>n+f.size,0);
  if(photoBytes>L.photos){setError(`Send up to ${mb(L.photos)} of photos with one message.`);return;}
  const over=takeFiles.find(f=>f.size>(PIP_DOCUMENT_EXTENSIONS.includes(fileExtension(f.name))?L.document:PIP_TEXT_FILE_BYTES));
  if(over){setError(PIP_DOCUMENT_EXTENSIONS.includes(fileExtension(over.name))?`${over.name} is over ${mb(L.document)}; send a document of ${mb(L.document)} or less.`:`${over.name} is over 1 MB; send a text or code file of 1 MB or less.`);return;}
  const fileBytes=filesNow.reduce((n,f)=>n+f.bytes,0)+takeFiles.reduce((n,f)=>n+f.size,0);
  if(fileBytes>L.filesBytes){setError(`Send up to ${mb(L.filesBytes)} of files with one message.`);return;}
  if(photoBytes+fileBytes>L.message){setError(`Send up to ${mb(L.message)} of photos and files with one message.`);return;}
 }else{
  const used=images.reduce((n,i)=>n+i.bytes,0)+filesNow.reduce((n,f)=>n+f.bytes,0),bytes=used+takeImages.reduce((n,f)=>n+f.size,0)+takeFiles.reduce((n,f)=>n+f.size,0);
  if(takeImages.length<list.length||takeFiles.length<usable.length)setError(`Send up to ${PIP_MAX_IMAGES} images and ${PIP_MAX_FILES} files with one message.`);
  if(bytes>PIP_MAX_IMAGE_BYTES){setError('Send up to 2 MB of images and files with one message.');return;}
 }
 const cap=spool?PIP_SPOOL_IMAGES:PIP_MAX_IMAGES,fileCap=spool?L.files:PIP_MAX_FILES;
 // Each is read in the background; they join the message in the order you picked them, not the order they finish.
 const read=file=>new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(typeof reader.result==='string'?reader.result:'');reader.onerror=()=>resolve('');reader.readAsDataURL(file);});
 void Promise.all(takeImages.map(read)).then(results=>{
  const added=takeImages.map((file,i)=>{const heic=heicFile(file),result=results[i];if(!result.startsWith(heic?'data:':'data:image/'))return null;
   const data=heic?result.replace(/^data:[^;,]*(;[^,]*)?;base64,/,`data:${String(file.type||'').toLowerCase()==='image/heif'?'image/heif':'image/heic'};base64,`):result;
   return {data,bytes:file.size,name:file.name||'',...(heic?{heic:true,name:file.name||'iPhone photo'}:{})};}).filter(Boolean);
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
 // A logo already drawn (with the card's markup) gets the backdrop its own colours want (media/pluginCalls.js).
 for(const img of document.querySelectorAll('.app-link-mark.has-logo img'))if(!img.parentElement.classList.contains('logo-on-dark')&&!img.parentElement.classList.contains('logo-on-light'))globalThis.DgcPluginCalls?.backdrop(img,img.parentElement);
 const wanted=[...new Set([...document.querySelectorAll('[data-plugin-mark]')].map(n=>n.dataset.pluginMark))].filter(id=>!pluginLogoCache.has(id)&&!pluginLogoAsked.has(id)).slice(0,16);
 if(wanted.length){for(const id of wanted)pluginLogoAsked.add(id);vscode.postMessage({type:'pipsPluginLogos',plugins:wanted});}
 const apps=[...new Set([...document.querySelectorAll('[data-app-mark]')].map(n=>n.dataset.appMark))].filter(id=>!appLogoCache.has(id)&&!appLogoAsked.has(id)).slice(0,16);
 if(apps.length){for(const id of apps)appLogoAsked.add(id);vscode.postMessage({type:'pipsAppLogos',apps});}
}
function takePluginLogos(logos,app=false){
 if(!record(logos))return;
 for(const [id,src] of Object.entries(logos)){
  if(!(app?/^[a-z0-9][a-z0-9_]{1,39}$/:/^[a-z0-9][a-z0-9-]{0,63}$/).test(id)||typeof src!=='string'||src&&!/^data:image\/(png|svg\+xml|x-icon);base64,/.test(src))continue;
  (app?appLogoCache:pluginLogoCache).set(id,src);
  if(!src)continue;
  for(const mark of document.querySelectorAll(`[data-${app?'app':'plugin'}-mark="${id}"]`)){const img=document.createElement('img');img.alt='';img.src=src;mark.replaceChildren(img);if(mark.classList.contains('app-link-mark')){mark.classList.add('has-logo');globalThis.DgcPluginCalls?.backdrop(img,mark);}}
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
// A reply's videos (API 71): each placeholder gets its job's figure (media/videoPlayer.js), kept across redraws so a
// playing video isn't reloaded; it reads the job's state from the host until the video is made.
const messageVideos=new Map();
function hydrateMessageVideos(){
 if(!window.DgcVideo)return;
 if(!window.DgcVideo.hasHost())window.DgcVideo.host(m=>vscode.postMessage(m));
 for(const node of root.querySelectorAll?.('[data-message-video]')||[]){
  const id=node.dataset.messageVideo;if(!/^vid_[0-9a-f]{12}$/.test(id||'')||node.firstElementChild)continue;
  const job=S.messages.flatMap(m=>Array.isArray(m.videos)?m.videos:[]).find(v=>v&&v.id===id)||{id,state:'queued'};
  let fig=messageVideos.get(id);
  if(!fig||fig._disposed){fig=window.DgcVideo.figure(job,{poll:true});messageVideos.set(id,fig);}
  else window.DgcVideo.update(job);
  node.appendChild(fig);
 }
}
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
function openMessageImage(key,save=false){
 const [messageId,index]=String(key||'').split(':');
 if(!S.selected||!messageId||!/^\d+$/.test(index||''))return;
 vscode.postMessage({type:'pipsOpenPhoto',pip_id:S.selected,message_id:messageId,index:Number(index),...(save?{save:true}:{})});
}
// A plugin's card asked to send a message as yours (MCP Apps ui/message, labelled with its plugin): sent as the box
// sends one, when the box is empty and the Pip isn't answering.
function sendCardMessage(text){
  if(draft.chatText.trim()){S.notice='Send or clear what you\u2019re typing first, then try the card again.';render();return false;}
  if(S.chatActiveRun||S.busy||!S.pip){S.notice=`${S.pip?.name||'The Pip'} is still answering. Try the card again when it is done.`;render();return false;}
  draft.chatText=String(text||'').slice(0,CHAT_MAX_CHARS);void sendChat();return true;
}
// ---- the queue: Alt+Enter while a Pip is answering keeps a message above the box (media/messagequeue.js, as in Work and
// ChatDGC). Enter still steers the running reply. When the reply finishes the first goes, then the next when that one's
// reply finishes. A reply that failed or was stopped sends none: they come back to the box for the person to decide.
const MAX_CHAT_QUEUE=10;
let chatQueueSeq=0;
const chatQueue=(pip=S.selected)=>chatQueues.get(pip)||[];
function setChatQueue(list,pip=S.selected){if(list.length)chatQueues.set(pip,list);else chatQueues.delete(pip);rememberView();drawChatQueue();}
function queueChatMessage(){
 const text=messageWords(draft.chatText);if(!text||!S.selected)return;
 if(pendingImages().length||pendingFiles().length){setError('Send attached photos or files after this reply. Queued messages are text only.');return;}
 if(cardNumber(text)){refuseCard(S.selected);return;}
 {const tooLong=chatTooLong(text);if(tooLong){setError(tooLong+' Nothing was queued.');return;}}
 const list=chatQueue();if(list.length>=MAX_CHAT_QUEUE){setError(`${MAX_CHAT_QUEUE} messages are already waiting: send them first, or remove one.`);return;}
 const fromBox=!!chatBox&&messageWords(chatBox.el.value)===text,marks=fromBox&&S.displayMentions?chatBox.marks(text):[];
 setChatQueue([...list,{id:`q${Date.now()}-${++chatQueueSeq}`,text,...(marks.length?{marks}:{})}]);
 // The page's markup still says what the box said when it was last drawn, so a redraw alone can leave the words there.
 chatEdit(()=>{draft.chatText='';const box=$('chatText');if(box)box.value='';chatDrafts.set(S.selected,'');rememberView();render();});
 fitChatInput();
}
// A message back in the box, with its @ marks where they were.
function giveBackToBox(pip,message){
 const parts=Mentions?.partsOfMarks(message.text,message.display_mentions);
 chatEdit(()=>{draft.chatText=message.text;chatDrafts.set(pip,message.text);if(parts)chatMarks.set(pip,{text:message.text,parts});else chatMarks.delete(pip);rememberView();render();});
}
function chatQueueSendText(text,marks){
 rememberMarks();
 const saved=draft.chatText;draft.chatText=text;void sendChat({marks:marks||[]});
 if(S.sending?.text===text){draft.chatText=saved;chatDrafts.set(S.selected,saved);rememberView();render();return true;}
 draft.chatText=saved;return false;
}
// ---- the bar for what is going on (the tray, media/shared/tray.js: the same bar as Work's and ChatDGC's). One line
// on the box, in a soft shell round both: the messages queued for this Pip, a routine of its running, its computer
// busy with another request and what a paste was cleaned of are each a pill; a pill opens its detail just above. A fix
// DGC is making is no pill (his call, 14 Nov night): it is the sub-agent's row in the chat and the count under the box.
// Nothing going on: no bar. What its computer holds for your okay stays a card above the bar: it asks you something.
const TRAY_ICONS={queue:'<path d="M2.5 4h1M2.5 8h1M2.5 12h1M6 4h7.5M6 8h7.5M6 12h7.5"/>',routine:'<circle cx="8" cy="8" r="6"/><path d="M6.7 5.6v4.8L10.6 8Z"/>',
 computer:'<rect x="2" y="3" width="12" height="8" rx="1.2"/><path d="M6 13.5h4M8 11v2.5"/>',
 paste:'<path d="M1.8 8S4 4.2 8 4.2 14.2 8 14.2 8 12 11.8 8 11.8 1.8 8 1.8 8Z"/><circle cx="8" cy="8" r="1.7"/><path d="M3 13 13 3"/>',up:'<path d="m4 10 4-4 4 4"/>'};
const trayIcon=name=>`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TRAY_ICONS[name]||''}</svg>`;
const TRAY_TITLES={queue:'Queued messages',routine:'Routine running',computer:'Its computer',paste:'Pasted text'};
let chatTray=null,chatTrayParts=null,chatTrayHome=null,chatTrayNote=null,chatTraySig='',chatTrayPip='';
function trayRoutine(){const live=S.live,run=S.chatActiveRun;return live?.routine&&live.pipId===S.selected&&run&&live.runId===run.id?{title:String(live.routine),run}:null;}
// Its computer is busy with another request of yours: the run says so itself ("Waiting for its computer: it's finishing ...").
function trayComputer(){const run=S.chatActiveRun,act=run&&S.stream?.runId===run.id?S.stream.activity:null,m=/^Waiting for its computer(?::\s*(.*))?$/.exec(String(act?.label||''));return m?{line:String(act.label),doing:m[1]||''}:null;}
function traySpec(kind){
 const name=S.pip?.name||'This Pip';
 if(kind==='queue'){const count=S.chatWaiting.length+chatQueue().length;
  return {icon:'queue',num:String(count),after:'queued',detail:count===1?'message':'messages',label:`${count} ${count===1?'message':'messages'} queued for ${name}`,tip:`Queue · ${count} ${count===1?'message':'messages'} waiting`};}
 if(kind==='routine'){const r=trayRoutine();if(!r)return null;
  return {icon:'routine',num:r.title,after:'running',live:true,label:`${name}’s routine ${r.title} is running`,tip:`${r.title} · running`};}
 if(kind==='computer'){const c=trayComputer();if(!c)return null;
  return {icon:'computer',num:'Computer busy',detail:c.doing?c.doing.replace(/^it.s /,''):'',label:c.line,tip:c.line};}
 if(kind==='paste'){const c=chatBox?.cleaned,said=c&&globalThis.DgcPasteClean?.pill(c.n,c.counts);return said?{icon:'paste',...said}:null;}
 return null;
}
// A kind's detail: the queue's own rows, or what it is in words with the one thing to do about it.
function trayDetail(kind){
 if(kind==='queue')return chatTrayHome.querySelector('#chat-queue-box')||chatTrayParts.popBody.querySelector('#chat-queue-box');
 if(kind==='paste')return chatBox?.note||null;
 const name=S.pip?.name||'This Pip',lines=[],acts=[];
 if(kind==='routine'){const r=trayRoutine();if(!r)return null;
  lines.push(`${name} is running its routine “${r.title}”.`,'Its post in the chat says what it is doing.');
  if(usable())acts.push(['Stop','Stop this run',()=>{const id=S.chatActiveRun?.id;chatTray.close();if(id)void mutate({type:'cancel_pip_run',run_id:id},()=>loadMessages());}]);
 }else if(kind==='computer'){const c=trayComputer();if(!c)return null;
  lines.push(`${c.line}.`,'It carries on with this by itself as soon as its computer is free.');
 }else return null;
 const doc=chatTrayNote.ownerDocument;chatTrayNote.replaceChildren(...lines.map((text,i)=>{const p=doc.createElement('p');if(i)p.className='tray-note-more';p.textContent=text;return p;}));
 if(acts.length){const row=doc.createElement('div');row.className='tray-note-acts';for(const [text,title,run] of acts){const b=doc.createElement('button');b.type='button';b.className='tray-note-act';b.textContent=text;b.title=title;b.dataset.trayFocus='';b.addEventListener('click',run);row.append(b);}chatTrayNote.append(row);}
 return chatTrayNote;
}
// The bar is this view's own node: a redraw of the page leaves it alone, and a page drawn afresh gets it back.
function mountChatTray(){
 const slot=$('chat-tray');if(!slot||!globalThis.DgcTray)return false;
 if(!chatTray){
  const doc=slot.ownerDocument;
  chatTrayParts=globalThis.DgcTray.build('chat-tray',`Going on with this Pip`,doc);
  chatTrayParts.line.dataset.domOwn='1';
  chatTrayHome=doc.createElement('div');chatTrayHome.hidden=true;chatTrayParts.line.append(chatTrayHome);   // where a detail waits while its pill is closed
  chatTrayHome.innerHTML='<section id="chat-queue-box" class="chat-queue-box" aria-label="Queued messages" hidden><p class="chat-queue-head"></p><ol id="chat-queue" class="chat-queue-list"></ol></section>';
  if(chatBox?.note)chatTrayHome.append(chatBox.note);   // what a paste was cleaned of waits here until its pill opens it
  chatTrayNote=doc.createElement('div');chatTrayNote.className='tray-note';
  chatTray=globalThis.DgcTray.create({...chatTrayParts,moreId:'chat-tray-more',keep:['queue','computer','routine','paste'],spec:traySpec,
   solo:kind=>kind==='paste'?['Dismiss','Stop showing this notice',()=>chatBox?.note?.querySelector('button')?.click()]:null,detail:trayDetail,title:kind=>TRAY_TITLES[kind]||'',
   icon:spec=>`<span class="codicon" aria-hidden="true">${trayIcon(spec.icon)}</span>`,caret:`<span class="chip-caret codicon" aria-hidden="true">${trayIcon('up')}</span>`,
   popFocus:(kind,node)=>node.querySelector('[data-tray-focus], .dgc-queue-handle, button:not(:disabled)'),
   input:()=>$('chatText'),popTop:()=>document.querySelector('.pip-topbar')?.getBoundingClientRect().bottom||0,over:'.dgc-menu, .dgc-queue-menu',
   words:{more:'Show the rest of what is going on',list:'The rest of what is going on with this Pip'}});
 }
 if(slot!==chatTrayParts.line)slot.replaceWith(chatTrayParts.line);   // the page's markup holds only its place
 return true;
}
function drawChatTray(){
 if(!mountChatTray())return;
 const kinds=[];
 if(S.chatWaiting.length+chatQueue().length)kinds.push('queue');
 if(trayRoutine())kinds.push('routine');
 if(trayComputer())kinds.push('computer');
 if(chatBox?.cleaned.n)kinds.push('paste');
 const sig=JSON.stringify([S.selected,kinds.map(kind=>[kind,traySpec(kind)])]);
 if(sig===chatTraySig&&chatTray.kinds.join()===kinds.join())return;
 if(chatTrayPip!==S.selected){chatTrayPip=S.selected;chatTray.close({restore:false});}   // another Pip's chat: its details are its own
 chatTraySig=sig;
 chatTray.render(kinds);
 for(const kind of kinds)chatTray.paint(kind);
 const open=chatTray.open;if(open&&open.kind!=='more'&&open.kind!=='queue'&&open.kind!=='paste')trayDetail(open.kind);   // its words follow what it is doing
}
function drawChatQueue(){
 mountChatTray();
 const box=$('chat-queue');if(!box){drawChatTray();return;}
 // What DGC is keeping for the Pip's next turns comes first and answers first; the rest this view sends itself.
 const list=chatQueue(),held=S.chatWaiting,count=held.length+list.length,sig=JSON.stringify([S.selected,held,list,!!S.chatActiveRun,S.apiVersion>=73]);
 const section=box.closest('#chat-queue-box');if(section){section.hidden=!count;const head=section.querySelector('.chat-queue-head');if(head)head.textContent=count===1?'1 queued message':`${count} queued messages`;}
 if(box.dataset.sig===sig&&box.children.length===count){drawChatTray();return;}
 box.dataset.sig=sig;
 // One that brought pictures or files (Pips API 84) says so after its words; DGC's stand-in words for one with none aren't shown.
 const brought=item=>{const n=Array.isArray(item.images)?item.images.length:0,f=Array.isArray(item.files)?item.files.length:0,what=[n?`${n} ${n===1?'picture':'pictures'}`:'',f?`${f} ${f===1?'file':'files'}`:''].filter(Boolean).join(', ');
  const words=n&&item.text==='(sent an image)'||f&&item.text==='(sent a file)'?'':item.text.replace(/\s+/g,' ');return what?(words?`${words} \u00b7 ${what}`:what):words;};
 window.DgcMessageQueue?.render(box,[...held.map(item=>({id:item.id,text:brought(item)||'',title:item.text,fixed:true})),...list.map(item=>({id:item.id,text:item.text.replace(/\s+/g,' ')||'',title:item.text}))],{
  reorder:list.length>1?order=>{const byId=new Map(chatQueue().map(item=>[item.id,item]));setChatQueue(order.map(id=>byId.get(id)).filter(Boolean));}:null,
  // Steer is a mid-turn update to the reply running now; with none running, the message simply goes.
  steer:S.chatActiveRun&&S.apiVersion>=73?id=>{const item=chatQueue().find(i=>i.id===id);if(item&&chatQueueSendText(item.text,item.marks))setChatQueue(chatQueue().filter(i=>i.id!==id));}:null,
  remove:id=>{setChatQueue(chatQueue().filter(i=>i.id!==id));$('chatText')?.focus();},
  copy:(id,text)=>{const item=[...S.chatWaiting,...chatQueue()].find(i=>i.id===id);vscode.postMessage({type:'copy',text:item?.text||text});},
 });
 drawChatTray();
}
function drainChatQueue(){
 const pip=S.selected,list=chatQueue(pip);
 if(!list.length||S.chatActiveRun||S.chatWaiting.length||S.sending||S.busy||!S.messagesLoaded||!S.pip||S.pip.id!==pip)return;
 const last=[...S.messages].reverse().find(m=>m.role==='user');
 if(last&&['failed','cancelled'].includes(last.status)){
  const typed=draft.chatText.trim();
  setChatQueue([]);
  const boxParts=typed&&chatBox?.el.value===typed?chatBox.parts():null;
  const parts=[...list.map(item=>Mentions?.partsOfMarks(item.text,item.marks)||[item.text]),...(typed?[boxParts||[typed]]:[])].flatMap((piece,i)=>i?['\n\n',...piece]:piece);
  chatEdit(()=>{draft.chatText=[...list.map(item=>item.text),...(typed?[typed]:[])].join('\n\n').slice(0,CHAT_MAX_CHARS);chatDrafts.set(pip,draft.chatText);if(parts.some(part=>typeof part!=='string')&&parts.map(part=>typeof part==='string'?part:part.wire).join('')===draft.chatText)chatMarks.set(pip,{text:draft.chatText,parts});else chatMarks.delete(pip);rememberView();render();});
  return;
 }
 if(pendingImages().length||pendingFiles().length)return;
 if(chatQueueSendText(list[0].text,list[0].marks))setChatQueue(list.slice(1),pip);
}
async function sendChat(sent={}){
  if(S.apiVersion>=24&&!S.chatControls||archived()||!supportedSource()||!usable()||!S.messagesLoaded||S.busy||!S.pip||!takesMessages()||!S.runner?.online||S.runner?.paused)return;
  if(S.chatActiveRun&&S.apiVersion<73){setError('Update DGC before sending a mid-turn update to this Pip.');return;}
  const text=messageWords(draft.chatText),images=canAttachImages()?pendingImages().map(i=>i.data):[],files=canAttachImages()?pendingFiles().map(f=>({name:f.name,data:f.data})):[];if(!text&&!images.length&&!files.length){setError('Enter a message.');return;}
  // With no provider nothing is sent: it says so, with the way to fix it, and what you wrote stays in the box.
  if(S.noProvider&&!text.startsWith('/')){S.noProviderSaid=true;render();return;}
  // Before Pips API 84 a message sent while the Pip works carries words only; from 84 its pictures and files go with it.
  if(S.chatActiveRun&&(images.length||files.length)&&!attachesMidReply()){setError('Send attached photos or files after this reply. Mid-turn updates are text only.');return;}
  // /learn [what]: a skill drafted from this chat, shown here with Save, Edit and Cancel. It isn't a message to the Pip.
  bumpPip(S.selected);
  const learning=personalPip()&&!images.length&&!files.length?learnRequest(text):null;if(learning){void startLearn(learning);return;}
  // /goal <what>: this conversation's goal (Pips API 92), set with DGC and never sent to the Pip as a message.
  const goaling=goalsOn()&&!images.length&&!files.length?goalRequest(text):null;if(goaling){void setGoal(goaling.objective,text);return;}
  // A card number never leaves the box: not sent, not kept as a draft. The user types it on the Pip's screen.
  if(cardNumber(text)){refuseCard(S.selected);return;}{const tooLong=chatTooLong(text);if(tooLong){setError(tooLong+' Nothing was sent.');return;}}
  const boxText=!!chatBox&&messageWords(chatBox.el.value)===text,marks=S.displayMentions?(sent.marks||(boxText?chatBox.marks(text):[])):[],parts=sent.parts||(boxText?chatBox.parts():null);
  const options=S.apiVersion>=24?chosenChatOptions():undefined,signature=JSON.stringify({text,...(options?{chat_options:options}:{}),...(images.length?{images:images.map(i=>i.length+':'+i.slice(-64))}:{}),...(files.length?{files:files.map(f=>f.name+':'+f.data.length+':'+f.data.slice(-64))}:{})});const token=scope(),id=S.selected,conv=S.conv,generation=selectionGeneration,epoch=S.epoch;
  // The quote in the box goes with what was typed there; a message that waited in the queue was written before it.
  const reply=sent.marks?null:pendingReply();
  let pending=chatRequests.get(id);if(!pending||pending.signature!==signature||(pending.reply?.id||'')!==(reply?.id||'')){pending={text,signature,options,images,files,marks,parts,reply,key:`pip-chat-${globalThis.crypto.randomUUID()}`};chatRequests.set(id,pending);}S.busy=true;S.error='';
  // Your message is in the chat at once, as in DGC's own chat: the box clears now, not when the reply
  // is queued (a Pip's first step lists its workflow connectors' tools, which can take seconds).
  appLinkSettled.clear();S.sending={pip:id,conv,text,key:pending.key,marks:pending.marks,reply:pending.reply,at:new Date().toISOString()};chatFollow.sending();if(pending.reply)chatReplies.delete(id);chatEdit(()=>{if(messageWords(draft.chatText)===text){draft.chatText='';if(boxText)chatMarks.delete(id);}render();});
  try{const result=await send('send_pip_message',{pip_id:id,text,idempotency_key:pending.key,...(pending.options?{chat_options:pending.options}:{}),...(pending.images?.length?{images:pending.images}:{}),...(pending.files?.length?{files:pending.files}:{}),...(pending.marks?.length?{display_mentions:pending.marks}:{}),...(conv?{conversation_id:conv}:{}),...(pending.reply?{reply_to:pending.reply.id}:{})});if(epoch!==S.epoch)return;if(!record(result.message)||result.message.pip_id!==id||!record(result.run)||result.run.pip_id!==id)throw new Error('The saved message response did not match this Pip. Refresh before retrying.');nameFromFirstMessage(id,conv,text);
    // Its conversation left the screen meanwhile: what it kept is settled there, and the one shown is left alone.
    if(S.selected===id&&S.conv!==conv){settleStashedSend(id,conv,pending,text,false);void loadConversations();return;}
    if(chatRequests.get(id)?.key===pending.key)chatRequests.delete(id);if(chatDrafts.get(id)?.trim()===text)chatDrafts.delete(id);if(pending.images?.length)chatImages.delete(id);if(pending.files?.length)chatFiles.delete(id);rememberView();if(token!==scope()||generation!==selectionGeneration)return;if(messageWords(draft.chatText)===text)draft.chatText='';await Promise.all([loadMessages(),refresh(false)]);}
  catch(error){if(token===scope()&&generation===selectionGeneration&&S.conv!==conv){settleStashedSend(id,conv,pending,text,true);S.notice='That message didn’t go. It’s back in its conversation’s box.';render();}
   else if(token===scope()&&generation===selectionGeneration){if(String(errorText(error)).startsWith(CARD_REFUSED)){refuseCard(id);return;}
    // DGC refused it because this Pip has no computer to keep a project's copy on: the line with the button that adds one says so.
    const noComputer=error?.code==='needs_computer'&&projectsOn();if(noComputer){projectNeedsComputer=id;projectRefused=true;}
    chatEdit(()=>{if(!draft.chatText.trim()){draft.chatText=text;if(pending.parts)chatMarks.set(id,{text,parts:pending.parts});if(pending.reply&&!chatReplies.has(id))chatReplies.set(id,pending.reply);}if(!noComputer)setError(error);render();});}}
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
 return `<form id="github-form" class="section form"><h2>GitHub reads${infoTip('pipGithubSays','GitHub reads','Before each run, DGC reads these from GitHub with your own GitHub login (the gh CLI, or GH_TOKEN) and gives them to the model as reference. Read-only: nothing can comment, label, merge or push, and the model never chooses what to read.')}</h2>${plan?`<p>${esc(plan.repository)}</p><ul class="web-reads">${plan.reads.map(r=>`<li>${esc(githubReadLabel(r))}</li>`).join('')}</ul>`:'<p class="muted">No GitHub reads approved.</p>'}<label for="githubRepo">Repository (owner/name)</label><input id="githubRepo" data-draft="githubRepo" value="${esc(draft.githubRepo)}" placeholder="owner/name" autocomplete="off"${off?' disabled':''}><fieldset><legend>Read before each run</legend>${check('githubIssues','Open issues')}<label for="githubLabels">Only issues with these labels (optional, comma-separated)</label><input id="githubLabels" data-draft="githubLabels" value="${esc(draft.githubLabels)}" autocomplete="off"${off?' disabled':''}>${check('githubPulls','Open pull requests')}${check('githubChecks','CI checks for the commit each run reviews')}${check('githubFailed','Recent failed workflow runs')}</fieldset><div class="actions"><button type="submit"${off?' disabled':''}>Review GitHub reads…</button>${plan?button('remove-github-reads','Remove GitHub reads…',off):''}</div></form>`;
}
function githubProposalMarkup(proposal){
 const current=S.pip?.github_plan||null,proposed=proposal.definition?.github_plan||null;
 if(!current&&!proposed)return '';
 const list=v=>v?`${esc(v.repository)}<ul class="web-reads">${v.reads.map(r=>`<li>${esc(githubReadLabel(r))}</li>`).join('')}</ul>`:'None';
 return `<h3>GitHub reads</h3><dl class="meta"><dt>Current</dt><dd>${list(current)}</dd><dt>Proposed</dt><dd>${list(proposed)}</dd></dl><p class="muted">Read-only, with your own GitHub login. DGC makes these reads before each run; the model never chooses what to read.</p>`;
}
// Usage (API 41): what this Pip's runs cost. Pips have no daily limit (reported 2026-10-14).
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
 return `<section class="section" aria-label="Apps"><h2>Apps${infoTip('pipAppsSays','Apps',connected.length?`It reads these when you ask. Anything it would send or change waits for your Allow. Disconnect stops ${esc(S.pip?.name||'this Pip')} using this account. The account itself stays signed in under Settings → Plugins.`:`Ask ${esc(S.pip?.name||'this Pip')} in its chat to connect an app, like Gmail or Google Calendar.`)}</h2>${connected.length
  ?`<ul class="app-list">${connected.map(l=>`<li><span><strong>${esc(l.app)}</strong>${l.label?` <small>${esc(l.label)}</small>`:''}</span><button type="button" class="quiet" data-app-link-disconnect="${esc(l.id)}"${off?' disabled':''}>Disconnect</button></li>`).join('')}</ul>`
  :`<p class="muted">Nothing connected.</p>`}</section>`;
}
let appsSettingsPip='';
// A Personal Pip's page: which account each linked app is on. Disconnect, then asking the Pip again, gives the same choice.
function linkedAppsMarkup(off){
 if(remoteHost||S.apiVersion<43||!personalPip())return '';
 if(appsSettingsPip!==S.selected){appsSettingsPip=S.selected;void loadAppLinks();}
 const connected=(S.appLinks||[]).filter(l=>l.status==='connected');if(!connected.length)return '';
 return `<section class="pip-page-group" aria-label="Linked apps"><h3 class="pip-page-label">Linked apps${infoTip('pipLinkedSays','Linked apps',`It reads and acts only on these accounts. To change one, Disconnect, then ask ${esc(S.pip?.name||'it')} again and choose.`)}</h3>${connected.map(l=>`<div class="pip-page-row static" data-linked-app="${esc(l.id)}"><span class="row-words"><strong>${esc(l.app)}</strong><small>${esc(l.label||'Its linked account')}</small></span><button type="button" class="quiet pill" data-app-link-disconnect="${esc(l.id)}"${off||appLinkBusy?' disabled':''}>Disconnect</button></div>`).join('')}</section>`;
}
// "Apps it can use" on a Personal Pip's page (pips-09, Pips API 88): a switch per app (every app on until switched
// off; its link stays), each app's addresses with Disconnect, and one more address of an app it has. Below API 88 the
// page keeps "Linked apps", as before.
const appsUse={pip:'',asked:'',value:null,error:'',busy:false,seq:0,confirm:''};
function appsUseShown(){return S.apiVersion>=88&&!remoteHost&&personalPip();}
async function loadAppsUse(){
 if(!appsUseShown()||!usable())return;
 const token=scope(),pip=S.selected,sequence=++appsUse.seq;appsUse.asked=pip;
 try{const value=pipAppsPage(await send('get_pip_apps',{pip_id:pip}),pip);if(token!==scope()||sequence!==appsUse.seq||S.selected!==pip)return;
  appsUse.pip=pip;appsUse.value=value;appsUse.error='';render();}
 catch(error){if(token===scope()&&sequence===appsUse.seq&&S.selected===pip){if(appsUse.pip!==pip){appsUse.pip=pip;appsUse.value=null;}appsUse.error=errorText(error);render();}}
}
function appsUseMarkup(off){
 if(!appsUseShown())return linkedAppsMarkup(off);
 if(appsSettingsPip!==S.selected){appsSettingsPip=S.selected;void loadAppLinks();}
 if(appsUse.asked!==S.selected)void loadAppsUse();
 const mine=appsUse.pip===S.selected;
 return pipAppsMarkup(mine?appsUse.value:null,{esc,links:S.appLinks||[],busy:off||appsUse.busy||!!appLinkBusy,error:mine?appsUse.error:'',pipName:S.pip?.name||'This Pip',confirm:appsUse.confirm,
  waiting:shownAppLinks(S.appLinks).filter(l=>l.another===true).map(l=>l.toolkit),logo:a=>(a.kind==='plugin'?pluginLogoCache:appLogoCache).get(a.id)||''});
}
async function setAppUse(app,on){
 const row=appsUse.pip===S.selected?(appsUse.value||[]).find(a=>a.id===app):null;
 if(!row||appsUse.busy||!usable()||!appsUseShown()){render();return;}
 const token=scope(),pip=S.selected,name=S.pip?.name||'this Pip';let done=false;
 appsUse.busy=true;appsUse.error='';appsUse.confirm='';row.on=on;render();
 try{pipAppSwitched(await send('set_pip_app',{pip_id:pip,app,on}),app,on);if(token!==scope()||S.selected!==pip)return;
  done=true;S.notice=on?`${row.name} is on for ${name}.`:`${row.name} is off for ${name}. Its sign-in stays, so switching it back on needs nothing more.`;}
 catch(error){if(token===scope()&&S.selected===pip){row.on=!on;appsUse.error=errorText(error);}}
 // (Refused: the switch goes back and the reason stays in sight; the list is read again only after a change.)
 finally{appsUse.busy=false;if(token===scope()&&S.selected===pip){render();if(done)void loadAppsUse();}}
}
// One more address of an app it has: DGC raises its Connect card, which shows where Connect cards show (its chat).
async function addAppAddress(app){
 if(appsUse.busy||!usable()||!appsUseShown())return;
 const token=scope(),pip=S.selected;appsUse.busy=true;appsUse.error='';appsUse.confirm='';render();
 try{const link=appLink((await send('add_pip_app_account',{pip_id:pip,app}))?.link,pip);if(token!==scope()||S.selected!==pip)return;
  if(link.toolkit!==app||link.status==='connected')throw Error('DGC answered about another app card. Refresh the Pip.');
  putAppLink(link);appLinkChoices.delete(link.id);
  S.tab='chat';rememberView();void loadMessages();}
 catch(error){if(token===scope()&&S.selected===pip)appsUse.error=errorText(error);}
 finally{appsUse.busy=false;if(token===scope()){render();watchAppSignIn();}}
}
// "Skills" on a Personal Pip's page (pips-12, Pips API 88): a switch per skill, every skill on until switched off on
// this Pip. Below API 88 there is no such section.
const skillsUse={pip:'',asked:'',value:null,error:'',busy:false,seq:0};
async function loadSkillsUse(){
 if(!appsUseShown()||!usable())return;
 const token=scope(),pip=S.selected,sequence=++skillsUse.seq;skillsUse.asked=pip;
 try{const value=pipSkillsPage(await send('get_pip_skills',{pip_id:pip}),pip);if(token!==scope()||sequence!==skillsUse.seq||S.selected!==pip)return;
  skillsUse.pip=pip;skillsUse.value=value;skillsUse.error='';render();}
 catch(error){if(token===scope()&&sequence===skillsUse.seq&&S.selected===pip){if(skillsUse.pip!==pip){skillsUse.pip=pip;skillsUse.value=null;}skillsUse.error=errorText(error);render();}}
}
function skillsUseMarkup(off){
 if(!appsUseShown())return '';
 if(skillsUse.asked!==S.selected)void loadSkillsUse();
 const mine=skillsUse.pip===S.selected;
 return pipSkillsMarkup(mine?skillsUse.value:null,{esc,busy:off||skillsUse.busy,error:mine?skillsUse.error:'',pipName:S.pip?.name||'This Pip'});
}
async function setSkillUse(skill,on){
 const row=skillsUse.pip===S.selected?(skillsUse.value||[]).find(s=>s.name===skill):null;
 if(!row||skillsUse.busy||!usable()||!appsUseShown()){render();return;}
 const token=scope(),pip=S.selected,name=S.pip?.name||'this Pip';
 skillsUse.busy=true;skillsUse.error='';row.on=on;render();
 try{pipSkillSwitched(await send('set_pip_skill',{pip_id:pip,skill,on}),skill,on);if(token!==scope()||S.selected!==pip)return;
  S.notice=on?`${skill} is on for ${name}.`:`${skill} is off for ${name}. Other Pips keep it.`;}
 // (Refused: the switch goes back and the reason stays in sight.)
 catch(error){if(token===scope()&&S.selected===pip){row.on=!on;skillsUse.error=errorText(error);}}
 finally{skillsUse.busy=false;if(token===scope()&&S.selected===pip){render();document.querySelector(`[data-pip-skill-switch="${skill}"]`)?.focus?.({preventScroll:true});}}
}
// Folders in the Personal list (pips-12, Pips API 88): a Pip's folder is set on its page, from a small menu of the
// folders in use, "New folder…" and "No folder". A folder only groups the list. The Project list has none.
const folderUi={open:false,adding:false,error:'',busy:false};
function foldersListed(){return S.apiVersion>=88&&!remoteHost&&S.workspace?.kind==='personal';}
function pipFolderSetMarkup(off){
 if(!appsUseShown())return '';
 return pipFolderMarkup({esc,folder:pipFolder(S.pip?.profile),folders:foldersInUse(S.jobs.filter(p=>p.status!=='archived')),open:folderUi.open,adding:folderUi.adding,draft:draft.pipFolderName||'',busy:off||folderUi.busy,error:folderUi.error,pipName:S.pip?.name||'This Pip'});
}
function closeFolderMenu(focus=false){if(!folderUi.open)return;folderUi.open=false;render();if(focus)$('pip-folder-btn')?.focus({preventScroll:true});}
async function setPipFolder(group){
 if(!S.pip||folderUi.busy||S.busy||!usable()||!appsUseShown())return;
 if(group===pipFolder(S.pip.profile)){folderUi.open=false;folderUi.adding=false;folderUi.error='';render();$('pip-folder-btn')?.focus({preventScroll:true});return;}
 const token=scope(),pip=S.pip.id,name=S.pip.name;folderUi.busy=true;folderUi.error='';folderUi.open=false;render();
 try{const result=await send('set_pip_profile',{pip_id:pip,changes:{group}});if(token!==scope())return;
  if(!record(result)||result.pip_id!==pip||pipFolder(result.profile)!==group)throw Error('DGC answered about another Pip. Refresh.');
  putProfile(pip,result.profile);folderUi.adding=false;draft.pipFolderName='';if(group)foldersClosed.delete(group);
  S.notice=group?`${name} is in the folder “${group}”.`:`${name} is in no folder.`;}
 catch(error){if(token===scope())folderUi.error=errorText(error);}
 finally{folderUi.busy=false;if(token===scope()){render();(folderUi.adding?$('pipFolderName'):$('pip-folder-btn'))?.focus({preventScroll:true});}}
}
function addPipFolder(){
 let name;try{name=folderName(draft.pipFolderName);}catch(error){folderUi.error=errorText(error);render();$('pipFolderName')?.focus();return;}
 void setPipFolder(name);
}
// A whole team as one file (pips-12, Pips API 88), from the Personal list's Teams menu. Export: tick the Pips (all
// ticked at first) and name the team; the host saves the file where you choose. Import: the host reads the file you
// pick and DGC makes one setup card per Pip, which wait with the other new Pips. The page never handles a path.
const teamDraft={pips:[],ticked:new Set()};
const TEAM_FILE_WAIT=10*60*1000;   // a file dialog is open as long as the user leaves it open
function teamsShown(){return foldersListed()&&simpleMode();}
function teamMenuMarkup(){
 if(!teamsShown())return '';
 return `<details class="pip-menu team-menu" data-details="team-menu"><summary class="topbar-icon" aria-label="Teams" title="Teams: save Pips as one file, or add Pips from a file, a GitHub link or a Grok bot">${simpleIcon('more')}</summary><div class="tabs-menu dgc-menu dgc-menu-rows">${button('team-export','Export team…',S.busy||!usable()||!teamPips(S.jobs).length)}${button('team-import','Import team…',S.busy||!usable())}${button('team-import-github','Import from GitHub…',S.busy||!usable())}${button('team-import-grok','Bring a Grok bot…',S.busy||!usable())}</div></details>`;
}
function teamExportBody(){
 const live=S.jobs.filter(p=>p.status!=='archived').length;
 return teamExportMarkup({esc,pips:teamDraft.pips,ticked:teamDraft.ticked,name:draft.teamName||'',left:Math.max(0,live-teamDraft.pips.length),busy:S.busy});
}
function openTeamExport(){
 if(S.busy||!usable()||!teamsShown())return;
 const pips=teamPips(S.jobs);if(!pips.length)return;
 teamDraft.pips=pips;teamDraft.ticked=new Set(pips.slice(0,TEAM_MAX).map(p=>p.id));draft.teamName='';
 openReview({title:'Export team',description:'Save several Pips as one file that someone else can import.',body:teamExportBody(),confirm:'Export…',teamExport:true,pinned:true,blocked:false,request:{type:'export_pip_team_file'}});
 $('teamName')?.focus();
}
function teamTicked(box){
 const review=S.review;if(!review?.teamExport)return;
 if(box.checked)teamDraft.ticked.add(box.dataset.teamPip);else teamDraft.ticked.delete(box.dataset.teamPip);
 // Said in place, so the tick keeps the keyboard: how many are in, and whether the file can be made.
 const said=teamCount(teamDraft.pips.filter(p=>teamDraft.ticked.has(p.id)).length),line=$('team-count'),go=$('review-confirm');
 review.blocked=!said.ok;review.error='';review.body=teamExportBody();
 if(line){line.textContent=said.says;line.classList.toggle('is-stop',!said.ok);}if(go)go.disabled=S.busy||!usable()||!said.ok;
}
async function exportTeam(review){
 let request;try{request=teamExportRequest(teamDraft.pips,teamDraft.ticked,draft.teamName);}catch(error){review.error=errorText(error);renderReview();return;}
 if(S.busy||!usable()||!teamsShown())return;const token=scope();S.busy=true;review.error='';review.body=teamExportBody();renderReview();
 try{const done=teamExported(await broker.request({type:'export_pip_team_file',...request},TEAM_FILE_WAIT));if(token!==scope())return;
  S.busy=false;if(!done){review.body=teamExportBody();renderReview();return;}   // the save dialog was closed: the choices stay
  closeReview();S.notice=teamExportedNotice(done);render();}
 catch(error){if(token===scope()){S.busy=false;review.error=errorText(error);review.body=teamExportBody();renderReview();}}
}
async function importTeam(){
 if(S.busy||!usable()||!teamsShown())return;
 const token=scope(),workspace=S.workspace.id;S.busy=true;S.error='';render();
 try{const done=teamImported(await broker.request({type:'import_pip_team_file'},TEAM_FILE_WAIT));if(token!==scope()||!done)return;
  const here=done.setups.filter(s=>s.workspace_id===workspace).length;
  S.notice=teamImportedNotice(done,here);S.create=false;S.overview=true;
  // Its cards wait with the other new Pips, read as any are (five at a time).
  void loadSetups();void loadAttention();}
 catch(error){if(token===scope())setError(error);}
 finally{if(token===scope()){S.busy=false;render();}}
}
// Import a bot (pips-18, Pips API 88; src/pipImports.js), two more rows in the Teams menu. From GitHub: one link to a
// team file or a Pip's file, which DGC fetches. From a Grok bot: DGC's prompt to paste into the bot, then what it wrote.
// Either way DGC answers with setup cards, which wait with the other new Pips; DGC's refusals stay in the dialog.
function sourceImportBody(review){
 return review.sourceImport==='grok'?grokImportMarkup({esc,prompt:review.prompt||'',reply:draft.importReply||'',copied:review.copied===true,busy:S.busy})
  :githubImportMarkup({esc,url:draft.importLink||'',busy:S.busy});
}
function openGithubImport(){
 if(S.busy||!usable()||!teamsShown())return;
 draft.importLink='';
 const review={title:'Import from GitHub',description:'Add a shared team of Pips, or one Pip, from a file on GitHub.',confirm:'Import',working:'Importing…',sourceImport:'github',pinned:true,blocked:false,request:{type:'import_pip_source',source:'github'}};
 openReview({...review,body:sourceImportBody(review)});
 $('importLink')?.focus();
}
async function openGrokImport(){
 if(S.busy||!usable()||!teamsShown())return;
 draft.importReply='';
 const first={title:'Bring a Grok bot',description:'Grok can’t export a bot, so your bot describes itself and DGC sets up a Pip from what it writes.',confirm:'Import',working:'Importing…',sourceImport:'grok',pinned:true,blocked:true,prompt:'',copied:false,request:{type:'import_pip_source',source:'grok'}};
 openReview({...first,body:sourceImportBody(first)});
 const review=S.review;
 try{const prompt=importPrompt(await send('get_pip_import_prompt'));if(S.review!==review||review.scope!==scope())return;
  review.prompt=prompt;review.blocked=false;review.body=sourceImportBody(review);renderReview();$('import-prompt-copy')?.focus();}
 catch(error){if(S.review===review){review.error=errorText(error);renderReview();}}
}
// Typing in the link or the reply takes away what was said about the last try, in place (the box keeps the keyboard).
function importTyped(){
 const review=S.review;if(!review?.sourceImport||!review.error||S.busy)return;
 review.error='';$('review-root').querySelectorAll('.notice.error,.message-failure').forEach(n=>n.remove());
}
function copyImportPrompt(){
 const review=S.review;if(!review?.prompt||review.sourceImport!=='grok')return;
 const box=$('importPrompt');box?.select?.();   // selected too, so Ctrl+C copies it where the clipboard can't be written
 // The host's copy takes a short text (the embedded page's own limit); the page's clipboard is asked as well.
 if(review.prompt.length<=2048)vscode.postMessage({type:'copy',text:review.prompt});
 try{void window.navigator.clipboard?.writeText?.(review.prompt)?.catch?.(()=>{});}catch{}
 review.copied=true;review.body=sourceImportBody(review);
 // Said in place, so the button keeps the keyboard.
 const button=$('import-prompt-copy'),said=$('import-copied');if(button){button.textContent='Copied';button.focus({preventScroll:true});}if(said)said.textContent='Now paste it into your Grok bot.';
}
async function importSource(review){
 const grok=review.sourceImport==='grok';let request;
 try{request=grok?{source:'grok',text:grokReply(draft.importReply)}:{source:'github',url:githubLink(draft.importLink)};}
 catch(error){review.error=errorText(error);review.body=sourceImportBody(review);renderReview();$('review-root').querySelector('[role=alert]')?.scrollIntoView?.({block:'nearest'});$(grok?'importReply':'importLink')?.focus({preventScroll:true});return;}
 if(S.busy||!usable()||!teamsShown())return;
 const token=scope(),workspace=S.workspace.id;S.busy=true;review.error='';review.body=sourceImportBody(review);renderReview();
 try{const done=sourceImported(await send('import_pip_source',request));if(token!==scope())return;
  S.busy=false;draft.importLink='';draft.importReply='';closeReview();
  S.notice=sourceImportedNotice(done,done.setups.filter(s=>s.workspace_id===workspace).length,request.source);S.create=false;S.overview=true;render();
  // Its cards wait with the other new Pips, read as any are (five at a time).
  void loadSetups();void loadAttention();}
 catch(error){if(token===scope()){S.busy=false;review.error=errorText(error);review.body=sourceImportBody(review);render();if(S.review===review){renderReview();$('review-root').querySelector('[role=alert]')?.scrollIntoView?.({block:'nearest'});$(grok?'importReply':'importLink')?.focus({preventScroll:true});}}}
}
function grantsMarkup(){
 if(S.apiVersion<41||!S.pip||S.pip.source_policy?.mode!=='personal')return '';
 if(grantsState.pip!==S.selected){void loadGrants();return '';}
 const g=grantsState.value;
 if(!g)return grantsState.error?`<section class="section" aria-label="Allowed without asking"><h2>Allowed without asking</h2>${errorMarkup(grantsState.error)}</section>`:'';
 const off=S.busy||!usable();
 return `<section class="section" aria-label="Allowed without asking"><h2>Allowed without asking${infoTip('pipAllowedSays','Allowed without asking',g.grants.length?`When ${esc(S.pip?.name||'this Pip')} drafts one of these, it goes ahead without asking and tells you after. Anything else waits for you.`:'Every email, event or app action this Pip drafts waits for you. Choose <b>Always allow</b> when you approve one to let it do that kind of action on its own.')}</h2>${g.grants.length
   ?`${g.grants.map(x=>`<div class="grant-row"><span>${esc(x.label)} <span class="muted">· ${esc(grantWhere(x,true))}</span></span><button type="button" data-revoke-grant="${esc(x.id)}"${off?' disabled':''}>Stop allowing</button></div>`).join('')}`
   :'<p class="muted">Nothing yet.</p>'}</section>`;
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
 return `<section id="usage-section" class="section"><h2>Usage${infoTip('pipUsageSays','Usage','What its runs and replies spent, counted on the day each finished. Pips have no daily limit.')}</h2><dl class="meta usage-counts"><dt>Today</dt><dd>${n(u.today.tokens)} tokens · ${runs(u.today.runs)}</dd><dt>Last 30 days</dt><dd>${n(u.last_30_days.tokens)} tokens · ${runs(u.last_30_days.runs)}</dd></dl>${usageChart(u)}${errorMarkup(usageState.error)}</section>`;
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
 return `<form id="notify-form" class="section form"><h2>Notifications${infoTip('pipNotifySettingsSays','Notifications','New findings reach you in one daily digest in the main chat, not a message per run. Findings below the threshold stay in this Pip\'s reports.')}</h2>${errorMarkup(notifyState.error)}<label for="notifyMin">Show new findings that are</label><select id="notifyMin" data-draft="notifyMin"${off?' disabled':''}>${SEVERITIES.map(l=>option(l,l+' or worse',draft.notifyMin)).join('')}</select><label for="notifyAlert">Bring the digest back straight away for</label><select id="notifyAlert" data-draft="notifyAlert"${off?' disabled':''}>${SEVERITIES.map(l=>option(l,l+' or worse',draft.notifyAlert)).join('')}${option('off','Nothing: wait for the next day',draft.notifyAlert)}</select><div class="actions"><button type="submit"${off?' disabled':''}>Save notifications</button></div></form>${findingOutcomesMarkup()}`;
}
function findingOutcomesMarkup(){
 if(S.apiVersion<41||!auditPip())return '';
 if(outcomeState.pip!==S.selected){void loadFindingOutcomes();return '';}
 const o=outcomeState.value;
 const body=o?(o.reported?`<dl class="meta outcome-counts"><dt>Reported</dt><dd>${o.reported}</dd><dt>Accepted</dt><dd>${o.accepted}</dd><dt>Dismissed</dt><dd>${o.dismissed}</dd><dt>Still reported</dt><dd>${o.still_reported}</dd><dt>Gone after their file changed</dt><dd>${o.gone_after_change}</dd><dt>Gone without a change</dt><dd>${o.gone_without_change}</dd></dl>`:'<p class="muted">No findings reported yet.</p>'):outcomeState.loading?'<p class="muted">Loading…</p>':'';
 return `<section class="section" aria-label="Finding outcomes"><div class="section-head"><h2>Finding outcomes${infoTip('pipOutcomesSays','Finding outcomes',`What became of its findings. “Gone” means a later run stopped reporting it after a source change. It suggests a fix; it does not prove one.${outcomeState.value?.history_truncated?' Counted from the latest 200 reports.':''}`)}</h2>${button('refresh-findings',outcomeState.loading?'Loading…':'Refresh',!usable()||outcomeState.loading)}</div>${errorMarkup(outcomeState.error)}${body}</section>`;
}
function adaptationMarkup(){
 if(S.apiVersion<10)return '';
 const m=draft.adaptationMode,words={locked:'It never changes its own setup.',context_adaptive:'It uses notes you shared with it, but never changes its own setup.',suggest_changes:'It may suggest changes to its setup. Each one waits for you.',bounded_adaptive:'It may change only what you tick below, and you can see every change.',autonomous:personalPip()?'It may rename itself. Nothing else.':'It may rename itself and move to a newer commit. Nothing else.'}[m]||'';
 return `<form id="adaptation-form" class="section form"><h2>Its own changes${infoTip('pipAdaptationSays','Its own changes',`Changes it may make to itself. ${words} It can never change what it does, when it runs, its model or what it may use.`)}</h2><label for="adaptationMode" class="sr-only">Changes it may make to itself</label><select id="adaptationMode" data-draft="adaptationMode" aria-describedby="pipAdaptationSays">${Object.entries(ADAPTATION_MODES).map(([key,label])=>`<option value="${key}"${m===key?' selected':''}>${label}</option>`).join('')}</select>${m==='bounded_adaptive'?`<fieldset><legend>It may change</legend><label class="check-field"><input id="adaptationName" data-draft="adaptationName" type="checkbox"${draft.adaptationName?' checked':''}> Its name</label>${personalPip()?'':`<label class="check-field"><input id="adaptationSource" data-draft="adaptationSource" type="checkbox"${draft.adaptationSource?' checked':''}> The commit it reads</label>`}</fieldset>`:''}${S.adaptationDraftVersion!==S.pip.current_version?'<p class="notice">The Pip changed since you opened this. Reset it and choose again.</p>':''}<div class="actions"><button type="submit" class="primary"${S.busy||!usable()||!S.adaptationDirty?' disabled':''}>Save</button>${S.adaptationDirty?button('reset-adaptation','Reset',S.busy||!usable(),'quiet'):''}</div></form>${adaptationHistoryMarkup()}`;
}
function adaptationHistoryMarkup(){const capped=S.adaptations.length>=200;return `<section class="section" aria-label="Adaptation history"><div class="section-head"><h2>Automatic changes${infoTip('pipAdaptedSays','Automatic changes','Changes it made to itself under the setting above. They didn’t need your OK and didn’t start any work.')}</h2>${button('load-adaptations',S.adaptationsLoading?'Loading…':S.adaptationsLoaded?'Refresh changes':'Load changes',!usable()||S.adaptationsLoading)}</div>${errorMarkup(S.adaptationsError)}${S.adaptations.map(a=>`<article class="entry"><h3>${esc(date(a.created_at))}</h3><p>${esc(adaptationLabel(a.policy))}</p><dl class="meta">${Object.entries(a.changes).map(([key,value])=>`<dt>${key==='name'?'Name':'Source ref'}</dt><dd>${esc(value)}</dd>`).join('')}</dl><p class="goal">${esc(a.reason)}</p></article>`).join('')||(S.adaptationsLoaded?'<p class="muted">It hasn’t changed itself.</p>':'')}${S.adaptationCursor&&!capped?button('more-adaptations','Older automatic changes',!usable()||S.adaptationsLoading):''}${capped?'<p class="muted">Showing the latest 200.</p>':''}</section>`;}
async function loadAdaptations(more=false){
 if(S.apiVersion<10||!usable()||!S.pip||S.adaptationsLoading||more&&(!S.adaptationCursor||S.adaptations.length>=200))return;
 const token=scope(),sequence=++adaptationSeq,before=more?S.adaptationCursor:null;S.adaptationsLoading=true;S.adaptationsError='';render();
 try{const page=adaptationsPage(await send('list_pip_adaptations',{pip_id:S.selected,limit:20,...(before?{before_id:before}:{})}),S.selected,S.workspace.id);if(token!==scope()||sequence!==adaptationSeq)return;if(more&&(page.next_before_id===before||page.adaptations.some(a=>S.adaptations.some(old=>old.id===a.id)||a.to_version>=S.adaptations.at(-1).to_version)))throw new Error('Adaptation history did not advance. Refresh before retrying.');S.adaptations=more?[...S.adaptations,...page.adaptations]:page.adaptations;S.adaptationCursor=page.next_before_id;S.adaptationsLoaded=true;}
 catch(error){if(token===scope()&&sequence===adaptationSeq)S.adaptationsError=errorText(error);}
 finally{if(token===scope()&&sequence===adaptationSeq){S.adaptationsLoading=false;render();}}
}
function personalPip(pip=S.pip){return pip?.source_policy?.mode==='personal';}
// What was only a Personal Pip's is every Pip's from Pips API 96 (pips-flow-design Q8): what it remembers, its working
// notes, routines and a goal for its chat. A Pip with a folder has them in the one page and chat (One Pips).
function keepsAll(){return personalPip()||S.apiVersion>=FLOW_API&&onePips()&&!!S.pip;}
function currentTree(pip=S.pip){try{return sourcePolicy(pip?.source_policy).mode==='current_tree';}catch{return false;}}
// (One Pips: a Pip with its own box reads its copy of your files as they are on every run, a scheduled one too: the
// rule that current files are only read when you ask is for a Pip without one.)
function supportedSource(pip=S.pip){if(pip&&pip===S.pip&&folderBox())return true;try{const p=sourcePolicy(pip?.source_policy);return p.mode!=='current_tree'||S.apiVersion>=11&&['scout','lens','rook','lock','quill'].includes(pip?.pip_type??'rook')&&!pip.schedule&&!pip.event_trigger;}catch{return false;}}
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
  +`<h3>Excluded folders${infoTip('pipExcludedSays','Excluded folders',`Folders or patterns its copy leaves out, written as in a .gitignore file: uploads/, docs/screenshots/, *.mp4. It also leaves out what ${tree?'the project’s .gitignore and .dgcignore files list':'a committed .dgcignore lists'}, files over 4 MiB and links, and each run lists them.`)}</h3>`
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
// computer (reported: "once downloaded, only then the personal computer icon appears").
let screenSetup={pip:'',value:null,loading:false},screenSetupPoll=null;
async function loadDesktopStatus(){
 const pip=S.selected;
 if(S.apiVersion<43||remoteHost||!usable()||!pip||!mayHaveBox()||screenSetup.loading&&screenSetup.pip===pip)return;
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
 try{const value=pipComputer((await send('get_pip_computer',{pip_id:pip})).computer,pip);if(token!==scope()||S.selected!==pip)return;computerState.value=value;if(S.apiVersion>=43&&!remoteHost)void loadComputerSettled(pip,token);}
 catch(error){if(token===scope()&&S.selected===pip)computerState.error=errorText(error);}
 finally{if(token===scope()&&S.selected===pip){computerState.loading=false;render();}}
}
// While the chat is open, look again quietly (no blank button while it loads): a run may have hit a
// site's robot check, and the chat should say so at once.
async function refreshComputer(){
 const pip=S.selected;if(S.apiVersion<43||!mayHaveBox()||!usable()||computerState.loading)return;
 if(computerState.pip!==pip){void loadComputer();return;}
 if(!computerState.value?.granted)return;
 // What it needs from you: a robot check, and what its computer holds (shown under its reply).
 // And each computer's name and state (Pips API 86): the dot on its icon, and the menu under it.
 const needs=v=>JSON.stringify([v?.needs_you||null,(v?.actions||[]).filter(a=>a.status==='pending').map(a=>a.id),v?.names||null,v?.computers||null]);
 const token=scope(),before=needs(computerState.value);
 try{const value=pipComputer((await send('get_pip_computer',{pip_id:pip})).computer,pip);if(token!==scope()||S.selected!==pip||computerState.pip!==pip)return;
  computerState.value=value;if(needs(value)!==before)render();void loadComputerSettled(pip,token);}
 catch{/* the next look tries again */}
}
// A settled card stays as one quiet line where it was ("Allowed · Send a form to x"), under the reply that asked: a reply that
// said "the card is below" still has something below it. get_pip_computer holds five actions, sent ones included, so a
// busy computer would push lines out of the middle of a chat: they are read from the list, which holds fifty.
let computerSettled={pip:'',actions:[]};
async function loadComputerSettled(pip,token){
 try{const page=await send('list_pip_computer_actions',{pip_id:pip,limit:50});if(token!==scope()||S.selected!==pip)return;
  const actions=(Array.isArray(page?.actions)?page.actions:[]).map(a=>pipComputerAction(a,pip)).filter(a=>a.status!=='pending');
  const said=list=>JSON.stringify(list.map(a=>[a.id,a.status]));
  const before=computerSettled.pip===pip?said(computerSettled.actions):'[]';
  computerSettled={pip,actions};if(said(actions)!==before)render();}
 catch{/* the next look tries again */}
}
// Each one's place: under the last reply of the run that asked; while that reply is still being written, where the card
// was, after it; a run with no reply of its own, by time. {byMessage, byRun: under a run's post, tail}
function settledLines(shown){
 const byMessage=new Map(),byRun=new Map();let tail='';
 if(S.apiVersion<43||remoteHost||!(personalPip()||folderBox()))return {byMessage,byRun,tail};
 const add=(map,key,line)=>map.set(key,(map.get(key)||'')+line);
 const place=(run,created,line)=>{
  const reply=shown.filter(m=>m.role==='assistant'&&m.run_id===run).at(-1);
  if(reply){add(byMessage,reply.id,line);return;}
  if(run&&postsShown()&&postFor(run)){add(byRun,run,line);return;}
  if(run&&S.chatActiveRun?.id===run){tail+=line;return;}
  const at=Date.parse(created),before=shown.filter(m=>Date.parse(m.created_at)<=at).at(-1);
  if(before)add(byMessage,before.id,line);else if(!shown.length)tail+=line;
 };
 const c=computerState.pip===S.selected?computerState.value:null;
 if(c){
  const all=new Map();
  for(const a of computerSettled.pip===S.selected?computerSettled.actions:[])all.set(a.id,a);
  for(const a of Array.isArray(c.actions)?c.actions:[])if(a.status!=='pending')all.set(a.id,a);
  for(const a of [...all.values()].sort((x,y)=>Date.parse(x.created_at)-Date.parse(y.created_at))){
   const words=settledWords(a);if(!words)continue;
   place(a.run_id,a.created_at,`<p class="card-settled" data-computer-settled="${esc(a.id)}" title="${esc(`${a.summary.host}${a.summary.path}`)}">${esc(words[0])} · ${esc(words[1])}</p>`);
  }
 }
 // A Connect card too: linked or put away, it leaves its line under the reply that asked, for good. It used to show only
 // until the next message, and that reply's "choose Link Gmail on the card below" pointed at nothing (final check, 2026-11-07).
 for(const link of S.appLinks||[]){
  if(link.status==='connected')place(link.run_id,link.created_at,appLinkSettledMarkup(link,{esc,pipName:S.pip?.name||'This Pip'}));
  else if(link.status==='declined')place(link.run_id,link.created_at,`<p class="card-settled" data-app-link-declined="${esc(link.id)}">Not now · Link ${esc(link.app)}</p>`);
 }
 // A plugin's Allow card is the same: allowed, it goes, and the reply that offered it still says it's below. (Don't says so
 // in pluginNotRun; your own app says what it decided in ownAppDecidedCards.)
 for(const d of S.connectorDrafts||[]){
  if(d.status!=='prepared'||!d.source_run_id||isOwnApp(pluginDrafts.get(d.id+':'+d.digest)?.payload?.action?.server))continue;
  const what=/^COMPOSIO_/.test(d.subject)?'Do this in Composio':`Run ${d.subject}`;
  place(d.source_run_id,d.created_at,`<p class="card-settled" data-plugin-settled="${esc(d.id)}">Allowed · ${esc(what)}</p>`);
 }
 return {byMessage,byRun,tail};
}
// What its computer holds, under its reply: the decision the computer tab offers, so a user who never opens that tab
// still sees it. A reply that said "Starting with the hospital bill on its pay page" sat above nothing while "Let Bill
// Payer visit…?" waited only in the tab (three-asks test, 2026-10-20). A site: Allow / Not now here; a form or a payment:
// Review… (the screenshot and every field, then Send once) or Reject.
// They wait just above its box, as Work's approvals do (ui-04, asked 10 Nov): one at a time, "1 of 3" while several
// wait, the count kept as they are answered (2 of 3), and reset once none waits.
const waitingDock={pip:'',seen:new Set()};
function computerWaitingCards(){
 const c=computerState.pip===S.selected?computerState.value:null;if(!c||S.apiVersion<43||remoteHost)return '';
 // (A code card exists from Pips API 98: an older DGC holds none, and one it somehow listed is never drawn as a form.)
 const actions=(Array.isArray(c.actions)?c.actions:[]).filter(a=>!isCode(a.summary)||S.apiVersion>=CODE_API);
 const waiting=actions.filter(a=>a.status==='pending'&&!codeOver(a));
 // A code card says how it ended in its own place (sent, the page moved on, not typed in time), then goes.
 const ended=codeEnded(c);
 if(waitingDock.pip!==S.selected||!waiting.length){waitingDock.pip=S.selected;waitingDock.seen=new Set();}
 if(!waiting.length&&!ended)return '';
 if(ended)return `<div class="pip-approval-dock" id="pip-approval-dock" role="region" aria-label="Waiting for your answer">${codeCard(ended.action,'')}</div>`;
 waiting.forEach(a=>waitingDock.seen.add(a.id));
 const total=waitingDock.seen.size,count=total>1?`<span class="perm-count">${total-waiting.length+1} of ${total}</span>`:'';
 return `<div class="pip-approval-dock" id="pip-approval-dock" role="region" aria-label="Waiting for your answer">${waitingCard(waiting[0],count)}</div>`;
}
// A held request's buttons, from the one list of its answers (src/pipCareful.js heldRequestAnswers; the computer view's
// notification draws the same list): the first is the solid one, and each is sent its own way.
function heldButtons(a,s,name,off){
 const id=esc(a.id),how={login:`data-login-card="${id}"`,review:`data-computer-action="${id}"`,send:`data-computer-decide="${id}" data-approve="1"`,
  always:`data-computer-always="${id}"${off} title="${esc(coversDetail(s,name))}"`,reject:`data-computer-decide="${id}" data-approve="0"`};
 return heldRequestAnswers(s,name).map((b,i)=>`<button type="button" class="${i===0?'primary':'quiet'}" ${how[b.how]}${b.how==='always'?'':off}>${esc(b.label)}</button>`).join('');
}
function waitingCard(a,count){
 const name=S.pip?.name||'The Pip',off=S.busy||!usable()||archived()?' disabled':'';
 const s=a.summary||{},words=carefulWords(s,name);
 if(isCode(s))return codeCard(a,count);
 if(!words)return computerSubmitCard(a,name,off,count);
 return `<div class="dgc-card app-link" data-state="waiting" data-computer-card="${esc(a.id)}" role="group" aria-label="${esc(words[0])}"><div class="dgc-card-head app-link-head"><span class="dgc-card-icon app-link-mark" aria-hidden="true">!</span><div class="dgc-card-words app-link-words"><strong>${wordsHtml(words[0],s,esc)}</strong><small>${wordsHtml(words[1],s,esc)}</small></div>${count}</div><div class="dgc-card-actions app-link-actions">${heldButtons(a,s,name,off)}</div></div>`;
}
// A submit its computer holds, as the Soft card (approved 2026-11-05): what it is, what Always allow would cover, Send once /
// Always allow / Reject, and the rest under Details. A payment is never sent once in one tap: Review… shows it first. Since
// 15 Nov its card has Always allow too (his call: on every card), with one quiet line, "Inside its daily limit": a payment
// on that grant is made only within the Pip's daily dollar limit.
function computerSubmitCard(a,name,off,count=''){
 const s=a.summary,id=esc(a.id),pay=isPayment(s),every=asksEveryTime(s),title=pay?`Pay on ${s.host}?`:`Send a form to ${s.host}?`;
 // What it sends is chips, one a field ("amount: 5350.00"), hidden ones (a card number) left out; the line under the title says why DGC asks.
 const line=[s.payment===true?'It sends payment card details.':'',asksWords(s),'Nothing has been sent.'].filter(Boolean).join(' ');
 const sends=DgcCard.chips((Array.isArray(s.fields)?s.fields:[]).filter(f=>f&&typeof f.value==='string'&&f.value.trim()&&f.value!=='•••').map(f=>({label:`${f.name}: ${f.value.replace(/\s+/g,' ').trim()}`})),'What it sends');
 const rows=(Array.isArray(s.fields)?s.fields:[]).filter(f=>f.value!=='•••').map(f=>`<dt>${esc(f.name)}</dt><dd>${esc(f.value)}</dd>`).join('');
 const limit=limitWords(s);
 const details=`<details class="allow-details"><summary><span class="allow-preview" title="${esc(coversWords(s))}">${esc(coversWords(s))}</span><span>Details</span></summary>`
  +`<dl class="allow-meta"><dt>Sends to</dt><dd>${addressHtml(`${s.host}${s.path}`,esc)}</dd>${s.page?`<dt>From page</dt><dd>${addressHtml(s.page,esc)}</dd>`:''}${rows}</dl>`
  +(s.more_fields?`<p class="app-link-note">And ${esc(String(s.more_fields))} more fields.</p>`:'')
  +`<p class="app-link-note">${addressHtml(coversDetail(s,name),esc)}</p>`+(pay?'':`<button type="button" class="link allow-see" data-computer-action="${id}"${off}>See the page…</button>`)
  +'</details>';
 return `<div class="dgc-card allow-card" data-state="waiting" data-computer-card="${id}" role="group" aria-label="${esc(title)}"><div class="dgc-card-head app-link-head"><span class="dgc-card-icon app-link-mark" aria-hidden="true">${pay?'!':'↗'}</span><div class="dgc-card-words app-link-words"><strong>${wordsHtml(title,s,esc)}</strong><small>${esc(line)}</small></div>${count}</div>${sends}${details}${limit?`<p class="app-link-note allow-limit">${esc(limit)}</p>`:''}<div class="dgc-card-actions app-link-actions">${heldButtons(a,s,name,off)}</div></div>`;
}
// ---- The code card (Pips API 98; agreed design, pips-sandbox-design §4). A site sent a one-time code and the saved
// login has no authenticator key: the card has a field, the user types the code, DGC fills it into the Pip's page
// (fill_pip_code) and the Pip is told only that it was filled.
// The typed code is in that one field and in the one request that carries it, and nowhere else: `codeCards` keeps how
// each card stands (never what was typed), the field has no draft, the view's saved state has nothing of it, and the
// field is emptied and replaced by a new one the moment it is sent, refused, put off, or its card ends.
const CODE_API=98,CODE_SENT_STAYS=4000,CODE_WAIT=100000;
const codeCards=new Map();   // a card's id -> {pip, state: 'live'|'sending'|'sent'|'lost'|'expired'|'elsewhere', signedIn, error, action, timer, mine}
const codeBox=id=>[...document.querySelectorAll('input[data-code-field]')].find(box=>box.dataset.codeField===id)||null;
const codeState=a=>{let card=codeCards.get(a.id);if(!card){card={pip:a.pip_id,state:'live',signedIn:false,error:'',action:a,timer:0,mine:false};codeCards.set(a.id,card);}card.action=a;return card;};
// A code lives ten minutes: past its time the card has no field, whatever DGC has noticed yet.
const codePast=a=>Date.parse(a.expires_at)<=Date.now();
// Still listed as waiting, but over here: this view ended it (sent, or the page moved on), or its time is up.
function codeOver(a){
 if(!isCode(a.summary))return false;
 const card=codeCards.get(a.id);
 return codePast(a)||!!card&&['sent','lost','expired','elsewhere'].includes(card.state);
}
// The card this chat showed that has ended, to say so in its place: the newest one. A card answered while this chat
// wasn't showing it leaves only its line under the reply.
function codeEnded(c){
 const known=new Map((Array.isArray(c?.actions)?c.actions:[]).filter(a=>isCode(a.summary)).map(a=>[a.id,a]));
 for(const [id,card] of codeCards){
  if(card.pip!==S.selected){forgetCode(id);continue;}
  if(card.state==='sending')continue;
  // (DGC's short list of what its computer holds may have let go of it: the longer one, read for the settled lines, has it.)
  const now=known.get(id)||(computerSettled.pip===S.selected?computerSettled.actions.find(a=>a.id===id):null)||(card.state==='live'?null:card.action);
  if(!now){forgetCode(id);continue;}
  card.action=now;
  if(card.state==='live'){
   if(now.status==='pending'&&!codePast(now))continue;
   // It ended without this view: its time ran out, or it was answered on another screen.
   wipeCodeBox(id);card.error='';
   card.state=now.status==='lost'?'lost':now.status==='expired'||now.status==='pending'?'expired':'elsewhere';
  }
 }
 // A new card for the same site takes the place of the one that said its page had moved on.
 const live=[...known.values()].filter(a=>a.status==='pending'&&!codeOver(a));
 for(const [id,card] of codeCards)if(card.state!=='live'&&card.state!=='sending'&&live.some(a=>a.id!==id&&a.summary.site===card.action.summary.site))forgetCode(id);
 return [...codeCards.values()].filter(card=>!['live','sending'].includes(card.state)).at(-1)||null;
}
function forgetCode(id){const card=codeCards.get(id);if(card?.timer)window.clearTimeout(card.timer);codeCards.delete(id);}
function wipeCodeBox(id){const box=codeBox(id);if(box&&box.value)takeCode(box);else if(box)box.value='';}
function codeCard(a,count){
 const name=S.pip?.name||'The Pip',s=a.summary||{},words=codeWords(s,name),id=esc(a.id),card=codeState(a);
 const head=(sub)=>`<div class="dgc-card-head app-link-head"><span class="dgc-card-icon app-link-mark" aria-hidden="true">!</span><div class="dgc-card-words app-link-words"><strong>${wordsHtml(words.title,s,esc)}</strong>${sub?`<small>${esc(sub)}</small>`:''}</div>${count}</div>`;
 const box=(state,inner,label=words.title)=>`<div class="dgc-card app-link code-card" id="pip-code-card-${id}" data-state="${state==='live'||state==='sending'?'waiting':'settled'}" data-code-card="${id}" data-code-state="${state}"${state==='live'||state==='sending'?` data-computer-card="${id}"`:''} role="group" aria-label="${esc(label)}">${inner}</div>`;
 if(card.state==='sent'){
  const said=[words.sent,...(card.signedIn?[words.signedIn]:[])];
  return box('sent',head('')+`<p class="code-card-said" data-code-said="sent" role="status"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${esc(said.join(' · '))}</span></p>`);
 }
 if(['lost','expired','elsewhere'].includes(card.state)){
  return box(card.state,head('')+`<p class="code-card-said" data-code-said="${card.state}" role="status"><span>${esc(words[card.state])}</span></p>`
   +`<div class="dgc-card-actions app-link-actions"><button type="button" class="quiet" id="pip-code-ok-${id}" data-code-dismiss="${id}">OK</button></div>`);
 }
 // (Something else being saved turns its buttons off for a moment, never the field under the caret.)
 const sending=card.state==='sending',gone=!usable()||archived(),off=S.busy||gone;
 // When its ten minutes are up the card says so by itself.
 if(!card.timer){const left=Date.parse(a.expires_at)-Date.now();if(left>0&&left<3600000)card.timer=window.setTimeout(()=>{card.timer=0;render();},left+60);}
 return box(card.state,head(words.line)
  +`<form class="code-card-form" id="pip-code-form-${id}" data-code-form="${id}" autocomplete="off" novalidate>`
  +`<div class="code-card-row">${codeFieldMarkup(s,{esc,id:`pip-code-field-${a.id}`,action:a.id,pipName:name,sending,off:gone&&!sending,describedBy:card.error?`pip-code-error-${a.id}`:''})}`
  +`<div class="dgc-card-actions app-link-actions"><button type="submit" class="primary" id="pip-code-send-${id}"${sending||off?' disabled':''}>${sending?'Sending…':'Send'}</button>`
  +`<button type="button" class="quiet" id="pip-code-not-now-${id}" data-computer-decide="${id}" data-approve="0"${sending||off?' disabled':''}>Not now</button></div></div>`
  +(card.error?`<p class="dgc-card-error" id="pip-code-error-${id}" role="alert">${esc(card.error)}</p>`:'')
  +'</form>');
}
// Send: what was typed leaves its field for the one request that carries it, and is let go as that request is posted.
async function sendCode(id){
 const pip=S.selected,a=computerState.pip===pip?computerState.value?.actions?.find(x=>x.id===id&&x.status==='pending'&&isCode(x.summary)):null;
 if(!a||S.busy||!usable()||archived()||S.apiVersion<CODE_API||remoteHost)return;
 const card=codeState(a);if(card.state!=='live')return;
 const taken=takeCode(codeBox(id)),problem=codeProblem(taken.code);
 if(problem){taken.code='';card.error=problem;render();$(`pip-code-error-${id}`)?.scrollIntoView?.({block:'nearest'});codeBox(id)?.focus({preventScroll:true});return;}
 const token=scope(),request={type:'fill_pip_code',pip_id:pip,action_id:a.id,expected_digest:a.digest,code:taken.code};
 taken.code='';card.state='sending';card.error='';card.mine=true;render();codeBox(id)?.focus({preventScroll:true});
 // (The channel copies the request as it posts it: the one kept here while DGC answers has no code in it.)
 const pending=broker.request(request,CODE_WAIT);request.code='';
 let said='';
 try{
  const result=await pending;
  if(token!==scope()||S.selected!==pip){forgetCode(id);return;}
  if(!record(result)||typeof result.ok!=='boolean')throw Error('DGC’s answer about the code didn’t read. Refresh to see whether it was sent.');
  const done=pipComputerAction(result.action,pip);if(done.id!==a.id)throw Error('DGC’s answer was about another card. Refresh to see whether it was sent.');
  card.action=done;
  if(computerState.pip===pip&&computerState.value)computerState.value={...computerState.value,actions:computerState.value.actions.map(x=>x.id===a.id?done:x)};
  if(result.ok){
   card.state='sent';card.signedIn=result.signed_in===true;
   card.timer=window.setTimeout(()=>{if(codeCards.get(id)===card){forgetCode(id);render();}},CODE_SENT_STAYS);
   void loadMessages();   // the Pip carries on by itself
  }else if(done.status==='lost'||result.lost===true)card.state='lost';
  else if(done.status!=='pending')card.state=done.status==='expired'?'expired':'elsewhere';
  else{card.state='live';said=typeof result.error==='string'&&result.error?result.error.slice(0,300):'The code was not sent. Type it again.';}
 }catch(error){if(token!==scope()||S.selected!==pip){forgetCode(id);return;}card.state='live';said=errorText(error);}
 card.error=said;render();
 // (In a short window the card scrolls inside its place above the box: what DGC said is brought into sight.)
 if(said)$(`pip-code-error-${id}`)?.scrollIntoView?.({block:'nearest'});
 if(card.state==='live')codeBox(id)?.focus({preventScroll:true});else($(`pip-code-ok-${id}`)||chatBox?.el||$('chatText'))?.focus?.({preventScroll:true});
 void refreshComputer();
}
document.addEventListener('submit',event=>{const id=event.target?.dataset?.codeForm;if(!id)return;event.preventDefault();void sendCode(id);});
document.addEventListener('input',event=>{const box=event.target;if(!box?.dataset?.codeField)return;tidyCodeField(box);
 // What it said about the last try goes as the next one is typed (no redraw under the caret).
 const card=codeCards.get(box.dataset.codeField);if(card?.error){card.error='';render();}});
document.addEventListener('paste',event=>{const box=event.target;if(box?.dataset?.codeField&&!box.readOnly)pasteCode(box,event);});
document.addEventListener('click',event=>{const id=event.target?.closest?.('[data-code-dismiss]')?.dataset.codeDismiss;if(!id)return;forgetCode(id);render();(chatBox?.el||$('chatText'))?.focus?.({preventScroll:true});});
// From anywhere else on the Pip's page: its chat, at the card, with the keyboard in its field.
async function showCodeCard(id){S.tab='chat';S.overview=false;rememberView();render();void loadMessages();await revealCard(cardSelector('code',id,v=>CSS.escape(v)));}
async function decideInChat(id,approve){
 const pip=S.selected,a=computerState.pip===pip?computerState.value?.actions?.find(x=>x.id===id):null;if(!a||S.busy||!usable())return;
 // (Not now on a code card: whatever was typed is gone before anything else happens.)
 if(isCode(a.summary)){if(approve||codeCards.get(a.id)?.state==='sending')return;wipeCodeBox(a.id);const card=codeCards.get(a.id);if(card)card.error='';}
 const token=scope(),careful=Boolean(carefulWords(a.summary||{},''));S.busy=true;render();
 try{
  const done=pipComputerAction((await send('decide_pip_computer_action',{action_id:a.id,expected_digest:a.digest,approve})).action,pip);
  if(token!==scope())return;if(done.id!==a.id||done.status!==(approve?'approved':'rejected'))throw Error('The saved decision differs from your choice. Refresh to see it.');
  if(isCode(a.summary))forgetCode(a.id);
  S.notice=!approve?(isCode(a.summary)?codeWords(a.summary,S.pip?.name||'It').rejected:a.summary?.kind==='login'?`Not now. ${S.pip?.name||'It'} won’t ask to save a login for ${a.summary.site||'that site'} again today.`:careful?'Not now. It won’t do that.':'Rejected. Nothing was sent.'):careful?'Allowed. It opens the site and carries on.':'Sent as shown. It carries on.';
  computerState.value={...computerState.value,actions:computerState.value.actions.map(x=>x.id===a.id?done:x)};
 }catch(error){if(token===scope())setError(error);}
 finally{if(token===scope()){S.busy=false;render();void refreshComputer();}}
}
// Always allow on its Soft card: this submit now, and its route from now on, for this Pip's computer.
async function alwaysInChat(id){
 const pip=S.selected,a=computerState.pip===pip?computerState.value?.actions?.find(x=>x.id===id):null;if(!a||S.busy||!usable())return;
 const token=scope();S.busy=true;render();
 try{
  const result=await send('always_allow_pip_computer_action',{action_id:a.id,expected_digest:a.digest});
  const done=pipComputerAction(result.action,pip),g=actionGrant(result.grant);
  if(token!==scope())return;if(done.id!==a.id||done.status!=='approved')throw Error('The saved decision differs from your choice. Refresh to see it.');
  grantsState.pip='';S.notice=`Always allowed: ${g.label}. It carries on, and tells you after each one.`;
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
 return `<div class="dgc-card app-link" data-state="needs" data-card-refused="1" role="group" aria-label="${CARD_REFUSED}"><div class="dgc-card-head app-link-head"><span class="dgc-card-icon app-link-mark" aria-hidden="true">!</span><div class="dgc-card-words app-link-words"><strong>${CARD_REFUSED}</strong><small>Type it on ${name}’s screen instead. Nothing you typed was sent or kept.</small></div></div><div class="dgc-card-actions app-link-actions">${open?`<button type="button" class="primary" data-card-open="1">Open its computer</button>`:''}<button type="button" class="quiet" data-card-dismiss="1">OK</button></div></div>`;
}
// A site asked a person to prove they are not a robot: the Pip stopped; the user finishes it on its screen.
function needsYouCard(){
 const n=computerState.pip===S.selected?computerState.value?.needs_you:null;if(!n||S.apiVersion<43)return '';
 const name=esc(S.pip?.name||'This Pip');
 return `<div class="dgc-card app-link" data-state="needs" role="group" aria-label="${name} needs you"><div class="dgc-card-head app-link-head"><span class="dgc-card-icon app-link-mark" aria-hidden="true">!</span><div class="dgc-card-words app-link-words"><strong>${name} needs you</strong><small>${esc(n.host)} wants to check you’re not a robot. Finish it on ${name}’s computer; ${name} carries on after.</small></div></div><div class="dgc-card-actions app-link-actions"><button type="button" class="primary" data-needs-open="1"${archived()?' disabled':''}>Open its computer</button><button type="button" class="quiet" data-needs-done="1"${S.busy?' disabled':''}>I’ve done it</button></div></div>`;
}
async function finishedCheck(){
 const pip=S.selected;if(!usable()||!pip||S.busy)return;
 void mutate({type:'finish_pip_computer_check',pip_id:pip},()=>{if(computerState.pip===pip&&computerState.value){const {needs_you:_n,...rest}=computerState.value;computerState.value=rest;}S.notice=`${S.pip?.name||'The Pip'} is carrying on.`;void loadMessages();});
}
function computerMarkup(){const inner=computerInner();return inner&&`<div class="computer">${inner}</div>`;}
function computerInner(){
 if(S.apiVersion<42||!(personalPip()||folderBox())||remoteHost)return '';
 if(computerState.pip!==S.selected){void loadComputer();return '<h3>Computer</h3><p class="muted">Loading…</p>';}
 const c=computerState.value,off=S.busy||!usable()||archived();
 if(!c)return `<h3>Computer</h3>${errorMarkup(computerState.error)||'<p class="muted">Loading…</p>'}`;
 if(!c.granted)return `<h3>Computer</h3><p class="muted">Give ${esc(S.pip.name)} its own computer, separate from yours: a browser, a Terminal and files, so it can look things up and fill in forms for you.</p>${c.available?button('give-computer','Give this Pip a computer…',off):`<p class="muted">${esc(c.reason)}</p>`}`;
 const waiting=c.actions.filter(a=>a.status==='pending'&&!codeOver(a)&&(!isCode(a.summary)||S.apiVersion>=CODE_API));
 return `<h3>Computer</h3><p>${esc(S.pip.name)} has its own computer: ${S.apiVersion>=54?'a desktop with a browser, an image editor, documents, a PDF viewer, a Terminal and files, online to public websites':'a browser, a Terminal and files, online to public websites'}. Anything its browser would submit waits for you here.</p>${c.available?'':`<p class="notice">${esc(c.reason)}</p>`}<div class="actions">${button('open-computer',S.apiVersion>=43&&!remoteHost?'Open its computer':'Open browser',off||!c.available)}${button('stop-computer','Stop computer',off)}${button('remove-computer','Remove computer…',off)}</div>${waiting.length?`<h4>Waiting for you</h4>${waiting.map(a=>`<article class="computer-action"><div><strong>${isCode(a.summary)?esc(codeWords(a.summary,S.pip.name).attention):carefulWords(a.summary,S.pip.name)?esc(carefulWords(a.summary,S.pip.name)[0]):`${esc(a.summary.method)} ${esc(a.summary.host)}${esc(a.summary.path)}`}</strong><span class="muted">from ${esc(a.summary.page)}</span></div>${`<button type="button" data-computer-action="${esc(a.id)}"${off?' disabled':''}>${isCode(a.summary)?'Type it in the chat':'Review…'}</button>`}</article>`).join('')}`:''}`;
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
 // A code is typed on its card in the chat, and nowhere else on this page: there is no review of it to open.
 if(isCode(a.summary)){void showCodeCard(a.id);return;}
 let image='';
 if(a.frame&&a.run_id){try{image=pipComputerFrame(await send('get_pip_computer_frame',{run_id:a.run_id,frame:a.frame}),a.run_id,a.frame).image;}catch{image='';}}
 const s=a.summary,rows=s.fields.map(f=>`<dt>${esc(f.name)}</dt><dd>${esc(f.value)}</dd>`).join(''),words=carefulWords(s,S.pip?.name||'The Pip');
 if(words){
  // Careful mode held it before anything happened: allow the site, or this one carrying of app data.
  openReview({title:words[0],description:words[1],
   body:`${image?`<img class="computer-shot" alt="The page as the Pip left it" src="${image}">`:''}<dl class="meta">${s.kind==='site'?`<dt>Site</dt><dd>${esc(s.shown||s.site||s.host)}</dd><dt>Address</dt><dd>${esc(s.host)}${esc(s.path)}</dd>`:`<dt>Goes onto</dt><dd>${esc(s.host)}${esc(s.path)}</dd>`}${s.page?`<dt>From page</dt><dd>${esc(s.page)}</dd>`:''}</dl>${s.kind==='text'?`<p class="muted">Exactly this, all of it:</p><pre class="message-review-body">${esc(typeof s.text==='string'?s.text:s.fields.map(f=>f.value).join('\n'))}</pre>`:''}`,
   secondary:{id:'reject-computer-action',label:'Not now'},confirm:words[2],always:offersAlways(s),expiresAt:a.expires_at,computerAction:a.id,carefulKind:s.kind,
   request:{type:'decide_pip_computer_action',action_id:a.id,expected_digest:a.digest,approve:true}});
  return;
 }
 const name=S.pip?.name||'The Pip',say=reviewWords(s,name);
 openReview({title:say.title,description:say.description,
  body:`${image?`<img class="computer-shot" alt="The page as the Pip left it" src="${image}">`:''}<dl class="meta"><dt>Sends to</dt><dd>${esc(s.host)}${esc(s.path)}</dd><dt>From page</dt><dd>${esc(s.page)}</dd>${rows}</dl>${s.more_fields?`<p class="muted">And ${s.more_fields} more fields.</p>`:''}${say.notice?`<p class="notice">${esc(say.notice)}</p>`:''}${say.limit?`<p class="muted">${esc(say.limit)}</p>`:''}<p class="muted">${esc(say.sent)}</p>`,secondary:{id:'reject-computer-action',label:'Reject'},
  confirm:'Send once',always:true,expiresAt:a.expires_at,computerAction:a.id,request:{type:'decide_pip_computer_action',action_id:a.id,expected_digest:a.digest,approve:true}});
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
function openComputerView(number=0){
 // API 43: the computer opens as an editor tab with its Browser, Files and Terminal.
 if(S.apiVersion>=43&&!remoteHost&&S.pip&&S.pip.id===S.selected){vscode.postMessage({type:'pipsOpenComputer',pip:{id:S.pip.id,name:S.pip.name,pip_type:S.pip.pip_type},...(number&&S.apiVersion>=86?{number}:{})});return;}
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
  return `<section class="section"><h2>What it uses</h2>${computerMarkup()}${webReadsMarkup()}${S.apiVersion>=43&&!S.pip.app_plan?'':`<h3>${S.apiVersion>=43?'Reads first':'Connected apps'}${infoTip('pipReadsSays',S.apiVersion>=43?'Reads first':'Connected apps','What it reads before each task. Connect an app once in DGC Settings, then choose it here.')}</h3>${S.pip.app_plan?readList(S.pip.app_plan):'<p class="muted">None yet.</p>'}<div class="actions">${button('choose-app-access',S.pip.app_plan?'Change…':'Choose an account…',off||S.apiVersion<29||remoteHost)}${S.apiVersion>=43?'':button('setup-apps','Set up in chat',off,'quiet')}${S.pip.app_plan?button('remove-app-access','Remove…',off,'quiet'):''}</div>`}${canReviewMessages()||!remoteHost&&S.apiVersion>=32?`<p class="drafts-links"><span class="muted">What it prepared:</span>${canReviewMessages()?button('message-reviews','Actions',S.busy,'link'):''}${!remoteHost&&S.apiVersion>=32?button('email-drafts','Emails',S.busy,'link'):''}${!remoteHost&&S.apiVersion>=35?button('calendar-drafts','Calendar events',S.busy,'link'):''}${!remoteHost&&S.apiVersion>=37?button('connector-drafts','App actions',S.busy,'link'):''}</p>`:''}${skillsMarkup()}</section>`;
}
function projectSourceMarkup(){
 const p=S.pip;if(S.apiVersion<11)return `<section class="section"><h2>Source${infoTip('pipSourceSays','Source','Update DGC to change it.')}</h2><p class="settings-fact">${esc(sourcePolicyLabel(p.source_policy))}.</p></section>`;
 if(!['scout','lens','rook','lock','quill'].includes(p.pip_type??'rook'))return `<section class="section"><h2>Source${infoTip('pipSourceSays','Source','Patch and Pulse always work from a commit, and you approve what they may change or run each time.')}</h2><p class="muted">Committed code only.</p></section>`;
 const sourceSays=`Work already started keeps the code it started with. ${draft.sourceMode==='current_tree'?'Each time you ask, it copies your saved files (not unsaved edits, and skipping files that may hold secrets) and reads the copy. Your files aren’t changed. This turns off its schedule and event triggers, and it can’t take part in handoffs. Its branch setting stays as it is until you switch back.':'It reads committed code from its branch or commit. Uncommitted changes aren’t included. Switching back doesn’t bring back a schedule or triggers; set them again in Schedule.'}`;
 return `<form id="source-form" class="section form"><h2>Source${infoTip('pipSourceSays','Source',sourceSays)}</h2><p class="settings-fact">Now: ${esc(sourcePolicyLabel(p.source_policy))}.</p><label for="sourceMode">Code it reads from now on</label><select id="sourceMode" data-draft="sourceMode" aria-describedby="pipSourceSays"><option value="committed_only"${draft.sourceMode==='committed_only'?' selected':''}>Committed code</option><option value="current_tree"${draft.sourceMode==='current_tree'?' selected':''}>Your current files · only when you ask</option>${draft.sourceMode==='unsupported'?'<option value="unsupported" selected>Not supported here</option>':''}</select>${draft.sourceMode==='current_tree'?'<p class="notice">Turns off its schedule and handoffs.</p>':''}${S.apiVersion>=50&&draft.sourceMode!=='unsupported'?sourceRulesMarkup(p):''}<button type="submit" class="primary"${S.busy||!usable()?' disabled':''}>Save</button>${S.sourceDraftVersion!==p.current_version?'<p class="notice">This Pip changed while you edited this. Reset and choose again.</p>':''}<div class="actions">${button('reset-source','Reset',S.busy||!usable())}</div></form>`;
}
function lifecycleMarkup(){
 if(S.apiVersion<16)return archived()?'<p class="muted">Update DGC to restore this archived Pip.</p>':'';
 if(!canLifecycle())return '<p class="notice">Refresh, then try again.</p>';
 return `<details data-details="pip-lifecycle"${archived()?' open':''}><summary>${archived()?'Restore archived Pip':'Archive Pip'}${infoTip('pipLifecycleSays',archived()?'Restore archived Pip':'Archive Pip',archived()?'Restore brings it back paused. Nothing runs until you resume it.':'Archiving keeps its chat, reports and history. Work in progress must finish or be stopped first, and handoffs waiting for you must be answered; nothing is cancelled for you.')}</summary>${personalPip()?'':`<p class="muted">Version ${S.pip.current_version}</p>`}${button(archived()?'restore-pip':'archive-pip',archived()?'Restore…':'Archive…',S.busy||!usable())}${archived()&&S.apiVersion>=68?`<p class="muted">Deletes it and its saved data.</p>${button('delete-archived-pip','Delete permanently…',S.busy||!usable(),'danger-text')}`:''}</details>`;
}
function reviewPermanentDelete(){
 if(!usable()||!archived()||S.apiVersion<68||!canLifecycle())return;
 draft.deletePipName='';
 openReview({title:`Delete ${S.pip.name} permanently?`,description:'This erases its chat, runs, computer files, what it kept in your memory, saved sign-ins used only by this Pip, Pip-created artifacts and audit receipts. It also removes references to this Pip from other Pips. This cannot be undone.',
  body:'<p class="muted">Copies you exported or changes made in project files are outside this Pip’s private data.</p>',
  confirm:'Delete permanently',danger:true,permanentPip:true,
  request:{type:'delete_archived_pip',pip_id:S.selected,expected_version:S.pip.current_version,expected_lifecycle_revision:S.pip.lifecycle_revision}});
}
async function confirmPermanentDelete(review){
 const pip=S.pip,token=scope();
 if(!pip||draft.deletePipName!==pip.name){review.error='Type the exact Pip name to confirm deletion.';renderReview();$('deletePipName')?.focus();return;}
 if(S.busy||!usable())return;
 S.busy=true;review.error='';renderReview();
 try{
  const result=await broker.request({...review.request,expected_name:draft.deletePipName});
  if(token!==scope())return;
  if(result?.deleted!==true||result.pip_id!==pip.id)throw Error('Deletion was not confirmed by DGC. Refresh before trying again.');
  // Gone from the list and from its count: the home said "Showing 1 of 2" with one Pip left.
  const listed=S.jobs.some(p=>p.id===pip.id)||jobsExtra.some(p=>p.id===pip.id);
  S.jobs=S.jobs.filter(p=>p.id!==pip.id);jobsExtra=jobsExtra.filter(p=>p.id!==pip.id);draft.deletePipName='';
  if(listed&&Number.isSafeInteger(S.jobsTotal))S.jobsTotal=Math.max(S.jobs.length,S.jobsTotal-1);
  // A saved Output DGC couldn't read is left in place, never deleted on a guess: say which, and where. A notice, not an
  // error (nothing failed), and one that stays on screen.
  const left=Array.isArray(result.outputs_left)?result.outputs_left.filter(p=>typeof p==='string').slice(0,20):[],one=left.length===1;
  clearSelection();S.selected='';S.overview=true;S.tab='';
  S.notice=left.length?`${pip.name} was deleted permanently. DGC couldn’t read ${one?'a saved Output':`${left.length} saved Outputs`}, so it left ${one?'it':'them'} in place: ${left.join(', ')}. Delete ${one?'it':'them'} if ${one?'it was':'they were'} this Pip’s.`
   :`${pip.name} and its private data were deleted permanently.`;
  noticeStays=left.length?S.notice:'';
  rememberView();render();
 }catch(error){if(token===scope()&&S.review){review.error=errorText(error);renderReview();}}
 finally{if(token===scope()){S.busy=false;render();if(S.review)renderReview();}}
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
// "Reports to" on a Project Pip's Settings (Pips API 89, pipOwner.js): its owner session, the one Work chat its reports
// reach, and Change. A Personal Pip has its own chat; below API 89, and over a remote host, there is no row.
const ownerState={pip:'',asked:'',value:null,error:'',busy:false,seq:0,picker:null,titles:new Map()};
// From Pips API 96 no session owns a Pip (pips-flow-design Q2): the row and its commands are gone.
function ownerShown(){return S.apiVersion>=OWNERS_API&&S.apiVersion<FLOW_API&&!remoteHost&&!!S.pip&&!personalPip()&&!archived();}
function resetOwner(){ownerState.pip='';ownerState.asked='';ownerState.value=null;ownerState.error='';ownerState.busy=false;ownerState.picker=null;ownerState.seq++;}
// The titles the editor's Work list shows (the host's own answer): a session it has none for says when it is from.
async function loadWorkTitles(){try{ownerState.titles=workTitles(await send('list_work_session_titles',foldersOn()&&S.selected?{pip_id:S.selected}:{}));}catch{/* the sessions still say when they are from */}}
async function loadOwner(){
 if(!ownerShown()||!usable())return;
 const token=scope(),pip=S.selected,sequence=++ownerState.seq;ownerState.asked=pip;
 try{const [raw]=await Promise.all([send('get_pip_owner',{pip_id:pip}),loadWorkTitles()]);const value=pipOwner(raw,pip);if(token!==scope()||sequence!==ownerState.seq||S.selected!==pip)return;
  ownerState.pip=pip;ownerState.value=value;ownerState.error='';render();}
 catch(error){if(token===scope()&&sequence===ownerState.seq&&S.selected===pip){if(ownerState.pip!==pip){ownerState.pip=pip;ownerState.value=null;}ownerState.error=errorText(error);render();}}
}
function ownerSectionMarkup(off){
 if(!ownerShown())return '';
 if(ownerState.asked!==S.selected)void loadOwner();
 const mine=ownerState.pip===S.selected;
 return ownerMarkup(mine?ownerState.value:null,{esc,titles:ownerState.titles,picker:mine?ownerState.picker:null,busy:off||ownerState.busy,error:mine?ownerState.error:'',pipName:S.pip?.name||'This Pip'});
}
// Change: this project's Work sessions (the Pip's own project, as DGC lists them; 100 at most), newest first.
async function openOwnerPicker(){
 if(!ownerShown()||!usable()||ownerState.busy||ownerState.pip!==S.selected||!ownerState.value)return;
 const token=scope(),pip=S.selected,workspace=S.pip.workspace_id,picker={sessions:null,error:''};
 ownerState.picker=picker;ownerState.error='';render();
 try{
  const rows=[];let after='';
  for(let page=0;page<5;page++){const got=workspaceSessionsPage(await send('list_workspace_sessions',{workspace_id:workspace,limit:20,...(after?{after}:{})}),workspace,after);rows.push(...got.sessions);after=got.next_cursor;if(!got.has_more)break;}
  await loadWorkTitles();
  if(token!==scope()||S.selected!==pip||ownerState.picker!==picker)return;
  // Newest first: a session's id starts with when it began. The owner is always among them.
  const ids=rows.map(r=>r.session_id);if(ownerState.value.session&&!ids.includes(ownerState.value.session))ids.push(ownerState.value.session);
  picker.sessions=ids.sort().reverse();
 }catch(error){if(token===scope()&&S.selected===pip&&ownerState.picker===picker){picker.sessions=[];picker.error=errorText(error);}}
 if(token===scope()&&S.selected===pip&&ownerState.picker===picker){render();root.querySelector('.pip-owner [aria-checked="true"]')?.focus();}
}
async function chooseOwner(session){
 if(!ownerShown()||!usable()||ownerState.busy||ownerState.pip!==S.selected||!ownerState.value||!ownerState.picker)return;
 if((ownerState.value.session||null)===session){ownerState.picker=null;render();$('pip-owner-change')?.focus();return;}
 const token=scope(),pip=S.selected,name=S.pip?.name||'This Pip';
 ownerState.busy=true;ownerState.error='';render();
 try{const value=pipOwnerSet(await send('set_pip_owner',{pip_id:pip,session_id:session}),pip,session);if(token!==scope()||S.selected!==pip)return;
  ownerState.value=value;ownerState.picker=null;S.notice=session?`${name} now reports to that session.`:`${name} has no owner session. Its reports wait in the Pips view.`;}
 catch(error){if(token===scope()&&S.selected===pip)ownerState.error=errorText(error);}
 finally{ownerState.busy=false;if(token===scope()&&S.selected===pip){render();$('pip-owner-change')?.focus();}}
}
function jobSettingsMarkup(){
  if(archived())return `<section class="section"><h2>Archived${infoTip('pipArchivedSays','Archived','Its conversation and results are saved. Restore it to use it again.')}</h2><p class="goal">${esc(S.pip.goal)}</p>${lifecycleMarkup()}</section>`;
  const p=S.pip,off=S.busy||!usable();
  const what=S.editingGoal?`<form id="revision-form" class="form">${field('revisionGoal','What should it do?',true)}<div class="actions"><button type="submit" class="primary"${off?' disabled':''}>Save</button>${button('cancel-goal','Cancel',S.busy,'quiet')}</div></form>`:`<p class="goal">${esc(p.goal)}</p>`;
  return `<section class="section"><div class="section-head"><h2>What it does</h2><div class="actions">${S.editingGoal?'':button('edit-goal','Edit',off,'quiet')}${S.apiVersion>=23?button('setup-in-chat','Change in chat',off,'quiet'):''}</div></div>${what}</section>`
   +`<section class="section"><h2>When it runs${infoTip('pipRunsSays','When it runs',esc(quickScheduleParts().says))}</h2>${quickScheduleParts().html}</section>`
   // Which Work session its reports come to (Pips API 89): its owner session, and Change.
   +ownerSectionMarkup(off)
   // How much it asks, for a Project Pip (Pips API 80, pips-11): the same picker, about the handoffs it is sent.
   +(levelShown()?levelMarkup(levelState.pip===p.id?levelState.value:null,{esc,busy:off||levelState.busy,error:levelState.error,pipName:p.name,when:at=>shortDate(at)}):'')
   +artifactsSectionMarkup(p,off,true)
   +sourceSettingsMarkup()+githubReadsMarkup()
   +`<form id="model-form" class="section form"><h2>Model${infoTip('pipModelSays','Model',`The model this Pip uses. The list is the models from your DGC connection${subscriptionChoices(personalPip()).length?', and your own subscriptions':''}.`)}</h2>${modelPicker('pipModel','Model this Pip uses',draft.pipModel,personalPip(),true)}<div class="actions"><button type="submit" class="primary"${off||!S.modelDirty?' disabled':''}>Save model</button></div></form>`
   +appsMarkup()+grantsMarkup()+usageMarkup()
   +`<section class="section"><h2>Pause or archive${infoTip('pipPauseSays','Pause or archive',p.status==='paused'?'Paused. It does not run until you resume it.':'Pausing stops it from running. Archiving puts it away; you can restore it later.')}</h2><div class="actions">${button('toggle-pip',p.status==='paused'?'Resume':'Pause',off||S.apiVersion>=16&&!canLifecycle())}${S.apiVersion>=16&&canLifecycle()?button('archive-pip','Archive…',off,'quiet danger'):''}</div></section>`
   +`<details class="advanced section" data-details="advanced"><summary>Advanced${infoTip('pipAdvancedSays','Advanced','Most Pips never need these.')}</summary>${notifyMarkup()}${adaptationMarkup()}${personalPip()?'':projectSourceMarkup()}${shareMarkup()}</details>`;
}
function chooseType(id){const type=S.types.find(t=>t.id===id);if(!S.create||!type?.available||S.busy||!usable())return;rememberCreationDraft();S.createType=id;Object.assign(draft,creationDrafts.get(id)||{name:type.default_name,goal:type.default_goal,source_ref:'HEAD',createModel:'default'});S.createStep='configure';S.error='';render();$('name')?.focus();}
// A Pip's pin, at its row's corner: an outline until it is on the dock, then filled, and it stays. (Beside its row, not
// inside it: a row is a button, and a button can't hold a button.)
const PIN_PATH='M10.2 1.8l4 4-2.2.9-2.4 2.4.3 3.1-1.1 1.1-2.6-2.6L2.8 14l-.8-.8 3.3-3.4-2.6-2.6 1.1-1.1 3.1.3 2.4-2.4z';
// A Pip's on/off switch (0.52, asked 12 Nov): in the list at its row's right end, and in its own page and chat header.
// On is active, off is paused (dgc/pips.py pause_pip and resume_pip: an off Pip runs no routine and starts no run; its
// chat still answers). It is a button of its own beside the row, never inside it, so switching never opens the Pip.
// Not for Core (the main chat's Pip), not for an archived Pip, and not below the Pips API whose pause and resume take
// the Pip's revision (16, as src/pipsView.ts asks): there the row is as it was. The row shows what was asked at once;
// a refusal puts the switch back and DGC's words say why.
const pipSwitching=new Map();   // a Pip's id -> on or off, as asked, until DGC answers
// What DGC answered last for a switched Pip ({status, lifecycle_revision}). The one list (Pips API 94+) keeps its own copy
// of the Pips beside the folder list, and a list read that set off before the answer lands after it: a copy whose
// revision is older than this one shows this one, so the switch never flips back (his live report, 14 Nov: it
// "flickers, does not react and takes multiple times").
const pipSwitched=new Map();
function pipFresh(p){const known=record(p)?pipSwitched.get(p.id):null,rev=lifecycleRevision(p);return known&&rev!==null&&rev<known.lifecycle_revision?{...p,...known}:p;}
// The Pip a switch acts on, from every copy this page holds (its page, the one list, the folder list): the newest one.
function pipNamed(id){return [S.pip,...(one.pips||[]),...(S.jobs||[])].filter(p=>record(p)&&p.id===id).map(pipFresh).sort((a,b)=>(lifecycleRevision(b)??-1)-(lifecycleRevision(a)??-1))[0];}
function pipSwitchable(p){return !!p&&p.pip_type!=='core'&&['active','paused'].includes(p.status)&&S.apiVersion>=16&&lifecycleRevision(p)!==null&&lifecycleRevision(p)<Number.MAX_SAFE_INTEGER;}
function pipOff(p){return pipSwitchable(p)&&(pipSwitching.has(p.id)?!pipSwitching.get(p.id):p.status==='paused');}
function pipSwitchMarkup(p){
  if(!pipSwitchable(p))return '';
  const on=!pipOff(p),state=on?'checked':'unchecked',off=!usable();
  return `<button type="button" role="switch" class="switch pip-switch" id="pip-switch-${esc(p.id)}" data-pip-switch="${esc(p.id)}" aria-checked="${on}" data-state="${state}" aria-label="${esc(p.name)}, on or off" title="${on?'On. Switch it off to stop it running on its own.':'Off. Switch it on to let it run again.'}"${pipSwitching.has(p.id)?' aria-busy="true"':''}${off?' disabled data-disabled':''}><span data-state="${state}" aria-hidden="true"></span></button>`;
}
const PIP_OFF_SAYS='Off: it runs nothing on its own. It still answers when you write to it.';
async function switchPip(id){
  const p=pipNamed(id);
  if(!pipSwitchable(p)||pipSwitching.has(id)||!usable())return;
  const on=p.status==='paused',epoch=S.epoch;
  pipSwitching.set(id,on);S.error='';render();
  try{
    const next=(await send(on?'resume_pip':'pause_pip',{pip_id:id,expected_lifecycle_revision:p.lifecycle_revision}))?.pip;
    if(epoch!==S.epoch)return;
    if(!record(next)||next.id!==id||!['active','paused'].includes(next.status)||lifecycleRevision(next)===null)throw Error('DGC answered about another Pip. Refresh, then try again.');
    const now={status:next.status,lifecycle_revision:next.lifecycle_revision};pipSwitched.set(id,now);
    S.jobs=(S.jobs||[]).map(job=>job.id===id?{...job,...now}:job);if(S.pip?.id===id)S.pip={...S.pip,...now};
    one.pips=(one.pips||[]).map(job=>job.id===id?{...job,...now}:job);
  }catch(error){if(epoch===S.epoch){S.error=errorText(error);void refresh();}}   // (refused: the list is read again, so the next try carries what DGC holds now)
  finally{pipSwitching.delete(id);if(epoch===S.epoch){render();$(`pip-switch-${id}`)?.focus?.({preventScroll:true});}}
}
function jobPin(p){
  if(!dockKnown||remoteHost||p.status==='archived')return '';
  const on=dockPins.has(`pip:${p.id}`),label=on?'Unpin from the dock':'Pin to the dock';
  return `<button type="button" class="dgc-pin job-pin" data-pin-pip="${esc(p.id)}" aria-pressed="${on}" title="${label}" aria-label="${label}: ${esc(p.name)}"><svg viewBox="0 0 16 16" fill="${on?'currentColor':'none'}" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="${PIN_PATH}"/></svg></button>`;
}
function jobMarkup(p){return `<div class="job-slot">${jobRow(p)}${jobPin(p)}</div>`;}
function jobRow(p) {
  const type=pipType(p,S.types),pose=presentation(p,[],usable(),S.runner),reviews=pendingReviews(p);
  return `<button type="button" class="job" data-character="${esc(type?.id||'core')}" data-state="${esc(pose.state)}" data-job="${esc(p.id)}" title="${esc(p.name)} · ${esc(pose.label)}" aria-label="${esc(p.name)} · ${esc(pose.label)}" aria-current="${S.selected===p.id&&!S.create}">${pipAvatar(p,pose.state,`row-${p.id}`,type)}<span class="job-copy"><strong>${esc(p.name)}</strong><span class="job-role">${type?`${esc(type.name)} · ${personalPip(p)?(p.pip_type==='core'?'Your Primary Pip, in the main chat’s character':'Personal helper'):livePip(p)&&S.apiVersion>=60?'Live data':esc(type.role)}`:'Unsupported Pip type'}</span><span class="job-goal">${esc(p.goal||type?.description||'')}</span><small class="job-status"><i aria-hidden="true"></i>${esc(pose.label)}</small>${p.routine_health?healthMarkup(p.routine_health,{row:true}):`<span class="job-schedule">${esc(scheduleLabel(p.schedule))}</span>`}${reviews?`<span class="review-count">${reviews} waiting for you</span>`:''}</span></button>`;
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
  if(!Number.isSafeInteger(n)||n<0||S.apiVersion>=FLOW_API)return '';   // API 96: its reports stay in its own chat
  return `<p class="muted report-chats">${n?`Its finished reports also appear as a card in ${n===1?'the chat it reports to':`the ${n} chats it reports to`}: the chat it was set up in, and any chat it is attached to. Nothing changes until you ask there.`:`${postsShown()?'Its reports post in its own chat and stay here.':'Its reports stay here.'} To have them appear in a chat as a card you can act on, ask DGC in that chat: “attach ${esc(S.pip.name)} to this chat”.`}</p>`;
}
// Runs became History (API 51): every run, newest first, each row saying what it found; the chat has the posts.
function historyName(old){return postsShown()?'History':old;}
function rowWords(r,fallback){
  const post=postsShown()&&S.postsPip===S.selected?postFor(r.id):null;if(!post)return fallback;
  const w=postShort(post);return `<span class="hist-row-out" data-tone="${esc(w.tone)}">${esc(w.text)}</span>`;
}
// (History's first line was six lines in a 300 px side bar, 0.51 check: what the page is, in a sentence or two; how to
// get a first result is said where there are none.)
function runsMarkup() {
  const audits=S.runs.filter(r=>r.manifest?.run_kind!=='conversation');
  if(S.pip?.source_policy?.mode==='personal')return `<section class="section"><div class="section-head"><h2>${historyName('Results')}</h2></div><p class="muted">${postsShown()?`What ${esc(S.pip.name)} did on its own, newest first. Each result is also in its chat, where you can ask about it.`:S.pip.schedule||S.pip.event_trigger?`What ${esc(S.pip.name)} made on its schedule.`:`When ${esc(S.pip.name)} works on its own, on a schedule like “every morning, send me the news”, what it makes shows here. Ask for one in its chat.`}</p>${audits.map(r=>`<div class="run-row"><button type="button" data-run="${esc(r.id)}"><span>${rowWords(r,esc(personalStatusLabel(r.status)))}</span><small>${esc(date(r.created_at))}</small></button></div>`).join('')||`<p class="muted">No results yet.${postsShown()&&!(S.pip.schedule||S.pip.event_trigger)?' Ask for a schedule in its chat, like “every morning, send me the news”.':''}</p>`}</section>${reportMarkup()}`;
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
// When it runs: the control (`html`: the picker, or a few words where there is nothing to pick, and its next run), and
// the sentence that explains it (`says`), which a Pip's Settings keeps behind the "i" beside the title.
function quickScheduleMarkup(){const q=quickScheduleParts();return q.html+infoTip('pipRunsSaysHere','when it runs',esc(q.says));}
function quickScheduleParts(){
 const p=S.pip,off=S.busy||!usable(),next=record(p.schedule_state)?p.schedule_state.next_due_at:null;
 if(executionPip(p)&&!pulsePip(p))return {html:'<p class="muted">On a handoff only.</p>',says:'It runs only when you approve a handoff to it.'};
 if(currentTree())return {html:'<p class="muted">When you ask.</p>',says:'It runs when you ask. A schedule needs committed source (see Advanced).'};
 if(pulsePip(p)||documentationPip(p)&&S.apiVersion<20)return {html:`<p>${esc(p.event_trigger?eventTriggerLabel(p.event_trigger):scheduleLabel(p.schedule))}</p><button type="button" data-tab="schedule">Change…</button>`,says:''};
 const kinds=[['manual','When I ask'],['daily','Every day'],['weekdays','Weekdays'],['hours','Every few hours'],...(draft.quickKind==='custom'?[['custom',p.event_trigger?eventTriggerLabel(p.event_trigger):scheduleLabel(p.schedule)]]:[])];
 const says=draft.quickKind==='custom'?'Set in Advanced.':draft.quickKind==='manual'?'It runs when you ask it to.':draft.quickKind==='hours'?'':`Times are in ${draft.quickZone}.`;
 return {says,html:`<form id="quick-schedule-form" class="quick-schedule"><select id="quickKind" data-draft="quickKind" aria-label="When it runs"${says?' aria-describedby="pipRunsSays"':''}${off?' disabled':''}>${kinds.map(([key,label])=>`<option value="${key}"${draft.quickKind===key?' selected':''}>${esc(label)}</option>`).join('')}</select>${['daily','weekdays'].includes(draft.quickKind)?`<label class="inline">at <input id="quickTime" data-draft="quickTime" type="time" step="60" value="${esc(draft.quickTime)}" required${off?' disabled':''}></label>`:draft.quickKind==='hours'?`<label class="inline">every <input id="quickHours" data-draft="quickHours" type="number" min="1" max="168" step="1" value="${esc(draft.quickHours)}" required${off?' disabled':''}> hours</label>`:''}<button type="submit" class="primary"${off||draft.quickKind==='custom'||!S.quickDirty?' disabled':''}>Save</button></form>${next&&!S.quickDirty?`<p class="settings-fact">Next run ${esc(date(next))}.</p>`:''}`};
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
function requester(actor){const a=String(actor||'');return a==='editor-user'?'by you in the editor':a==='local-console'?'by you in the terminal':a==='pip-level:approve'?'by its level (Approve for me)':a==='pip-level:full'?'by its level (Do it all)':a.startsWith('main-')?'from the main chat':a.startsWith('core')?'by Core':'by another DGC surface';}
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
 return `<section class="section"><h2>Share this Pip${infoTip('pipShareSays','Share this Pip','Save its job as a file someone else can import into their DGC: name, goal, type, schedule and the pages it reads. Your connected accounts, memory, history and findings stay here.')}</h2><div class="actions">${button('export-pip-file','Export…',S.busy||!usable())}</div></section>`;
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
// A new Pip waiting for you is a card in Needs attention, and only there (the home had a second section above it,
// "1 new Pip waiting for you", showing the same request twice). What it would look after is its sentence; where and
// when are its chips.
function setupCardFor({setup,item}){
 const s=setup,type=s?S.types.find(t=>t.id===s.pip_type):characterType(item?.pip_type);
 const folder=s&&s.source_policy!=='personal'?String(s.project_root||'').replace(/[\\/]+$/,'').split(/[\\/]/).pop():'';
 const chips=s?[{label:type?.name||s.pip_type,icon:'pip'},s.source_policy==='personal'?{label:'Personal',icon:'name',title:'Personal · across your projects'}:{label:folder||'This project',icon:'doc',title:s.project_root},
  s.event_trigger?{label:`After each new commit to ${s.source_ref}`,icon:'code'}:{label:(w=>w.slice(0,1).toUpperCase()+w.slice(1))(scheduleWords(s.schedule).words),icon:'clock',title:scheduleLabel(s.schedule)},
  ...(s.run_now?[{label:'Also runs once now',icon:'repeat'}]:[])]:[];
 return setupCardMarkup({setup:s,item,chips,busy:S.busy||!usable(),face:s?avatar('waiting_approval',type,`setup-${s.id}`):''});
}
// The older layout (a remote host, or a DGC from before simple Pips) has no Needs attention of DGC's own: the same
// section, open, with only the new Pips waiting here. A list that did not load says so, with Check again.
function setupsMarkup(){
 if(S.apiVersion<23)return '';
 if(!setupRows.length)return setupError?`<section class="attention" aria-label="Needs attention">${errorMarkup(setupError)}${button('refresh-setups',setupLoading?'Checking…':'Check again',setupLoading||S.busy||!usable())}</section>`:'';
 const setups=setupRows.filter(r=>!heldRejects.has(r.id));
 return attentionMarkup(null,{esc,face:()=>'',expanded:2,busy:!usable(),setups,setupCard:setupCardFor,error:setupError,more:setupRows.length>=5?'Showing 5 new Pips. Answer one to see more.':'',at:attentionShowing(attentionCards(null,setups))});
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
async function dismissSetupFromAttention(item,{quiet=false}={}){
 if(item?.kind!=='setup'||S.busy||!usable())return;
 // The attention list can include a Personal setup while the Project tab is selected.
 if(item.workspace_id!==S.workspace?.id){
  const personal=S.workspaces.find(w=>w.id===item.workspace_id&&w.kind==='personal');
  if(!personal){setError('This Pip setup is unavailable here. Refresh Pips and try again.');return;}
  await enterWorkspace(personal);
 }
 if(S.busy||!usable())return;
 const token=scope();S.busy=true;render();
 try{
  const answer=await send('get_pip_setup',{setup_id:item.card});
  if(token!==scope())return;
  const setup=pipSetup(answer.setup,S.workspace.id,item.card);
  if(setup.status!=='pending')throw Error('This setup was already answered. Refresh Pips.');
  await send('reject_pip_setup',{setup_id:setup.id,expected_digest:setup.digest});
  if(token!==scope())return;
  setupRows=setupRows.filter(row=>row.id!==setup.id);
  if(!quiet)S.notice=setup.pip_id?'Dismissed. That Pip was not changed.':'Dismissed. No Pip was created.';
 }catch(error){if(token===scope())setError(error);}
 finally{if(token===scope()){S.busy=false;render();void loadSetups();void loadAttention();}}
}
async function resolveSetup(review){
 if(S.busy||review!==S.review||review.scope!==scope()||!usable())return;
 if(reviewBlocked(review)){review.error='This expired. Ask DGC again.';renderReview();return;}
 const token=scope(),workspace=S.workspace.id;S.busy=true;renderReview();
 try{const result=await send(review.request.type,{setup_id:review.request.setup_id,expected_digest:review.request.expected_digest});if(token!==scope()||!usable())return;const accepted=review.request.type==='accept_pip_setup',s=pipSetupResolution(result.setup,review.setup,accepted);
 closeReview();setupRows=setupRows.filter(row=>row.id!==s.id);S.busy=false;
 if(accepted){flowState.loaded=false;const selecting=select(s.receipt.pip_id),selectedScope=scope();await selecting;if(selectedScope!==scope()||!usable()||S.workspace?.id!==workspace)return;S.notice=s.source_policy==='personal'?(s.receipt.run_id?`${s.name} is on and starting its first task.`:`${s.name} is on. It works ${s.next_run_at?'on its schedule and ':''}when you ask.`):s.receipt.run_id?`${s.name} is on and starting its first run. ${s.pip_type==='pulse'?'Check its results before you count it as passing.':s.work_kind==='documentation_draft'?'Its first draft is on the way.':'It reviews the code; it doesn’t test the running app.'}`:s.next_run_at?`${s.name} is on. Its first run is ${date(s.next_run_at)}.`:`${s.name} is on. It runs when you ask.`;S.notice+=keepRunningTold(result);}else S.notice='Rejected. Nothing was created or changed.';
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
// Every section a Pip has: the tabs here, and a Project Pip's menu on the simple page.
function pipSections(){
 return [['chat','Chat'],['runs',onePips()&&!personalPip()?'Reports':postsShown()?'History':personalPip()?'Results':'Runs'],['job','Settings'],['schedule',pulsePip(S.pip)?'Plan & schedule':'Schedule'],['handoffs','Handoffs'],['revisions','Changes'],...(S.apiVersion>=14?[['memory','Memory']]:[]),['context','Context'],...(S.apiVersion>=13?[['notifications','Notifications']]:[])]
  .filter(([key])=>personalPip()&&key==='handoffs'?S.apiVersion>=30&&!remoteHost:key==='schedule'?(!executionPip(S.pip)||pulsePip(S.pip)):key!=='handoffs'||personalPip()||!documentationPip(S.pip));
}
function tabsMarkup(){
 if(!S.pip&&!S.selected)return '';
 const all=pipSections();
 const main=['chat','runs','job'],tab=([key,text])=>`<button type="button" data-tab="${key}" aria-pressed="${S.tab===key}"${['revisions','schedule'].includes(key)&&!S.pip?' disabled':''}>${text}</button>`;
 const shown=all.filter(([key])=>main.includes(key)||key===S.tab),more=all.filter(([key])=>!main.includes(key)&&key!==S.tab);
 return shown.map(tab).join('')+(more.length?`<details class="tabs-more" data-details="tabs-more"><summary aria-label="More sections">More</summary><div class="tabs-menu dgc-menu dgc-menu-rows">${more.map(tab).join('')}</div></details>`:'');
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
// settings, memory) stay one tap away in the chat's menu.
// Project Pips have the same page (reported 24 Oct: "yes, do it"), from Pips API 51, when their runs post in their
// chat: the paged list, a top bar with the Pip's name, Run now where a Personal Pip has its computer, and every section
// of the old page (History, Settings, Schedule, Handoffs, Changes, Memory, Context, Notifications) in its "…" menu. A
// new one is a character too, then its job and the code it reads. A remote view and an older DGC keep the old page.
const SIMPLE_CHARACTERS=['core','scout','lens','patch','rook','pulse','lock','quill'];
const flowDraft={name:'',mode:'reviewed',count:3,pips:['','','',''],tasks:['','','']};
const flowState={workspace:'',flows:[],suggestions:[],loaded:false,loadedAt:0,loading:false,error:'',form:false};
const PROJECT_SIMPLE_API=51;
function simpleMode(){return !remoteHost&&!!S.workspace&&S.apiVersion>=(S.workspace.kind==='personal'?43:PROJECT_SIMPLE_API);}
function projectHome(){return S.workspace?.kind!=='personal';}
// The chat (reported 24 Oct: "It should look and feel the same"): every Pip's, Personal and Project, is the one the
// simple Pips brought: short bubbles, the Pip at work with its face and name, its reply written into bubbles as it
// comes, time marks, actions under the pointer, the same box. A Project Pip keeps its page (list, History, Settings)
// and what only it has in its chat: its runs with Ask DGC to fix, and its source. A remote view keeps the one before.
function chatStyle(){return S.apiVersion>=43&&!remoteHost;}
// Personal | Project (reported 2026-10-21): two tabs, as the Sessions home has Chat | Work, where a dropdown listed
// every project DGC knows. Project is this window's folder and nothing else: another project's Pips are for that
// project's DGC to look after ("the user might ask this project's DGC to fix another project's Pips"). No folder
// open, the Project tab says so in one line. A remote view, and a CLI with no Personal Pips, have no tabs, as before.
function personalSpace(){return S.workspaces.find(w=>w?.kind==='personal')||null;}
function windowSpace(){return S.folderOpen&&S.currentWorkspaceId?S.workspaces.find(w=>w?.id===S.currentWorkspaceId&&w.kind!=='personal')||null:null;}
// The Project Folder dropdown (0.52, 12 Nov; Pips API 93; media/shared/folderpick.js): his call reverses "Project is this
// window's folder and nothing else". The Project tab has the dropdown the Work sessions have, on the same choice, which
// the extension keeps for every window (S.projectFolder: '' is All projects, the default; null where there is no
// dropdown: an older DGC, a remote view). All projects lists every project's Pips, each with its folder; a folder shows
// that folder's Pips, or says it has none. A Project Pip of any folder opens here. Needs attention asks for the Project
// Pips' cards of the choice. Personal Pips are never filtered.
S.projectFolder=null;S.folders=null;S.homeDir='';S.windowFolder=null;
let projectsAll={pips:[],read:false,busy:false,error:'',seq:0};
const addedFolders=new Map(),folderPicks=new Map();let folderPickSeq=0;
const folderLeaf=folder=>String(folder||'').replace(/[\\/]+$/,'').split(/[\\/]/).pop()||String(folder||'');
// A folder as the lists show it: the home folder as ~ (the whole path is its tooltip).
function tildePath(folder){const base=String(S.homeDir||'').replace(/[\\/]+$/,'');return !base?folder:folder===base?'~':folder.startsWith(base+'/')||folder.startsWith(base+'\\')?'~'+folder.slice(base.length):folder;}
function foldersOn(){return !remoteHost&&S.apiVersion>=93&&typeof S.projectFolder==='string'&&Array.isArray(S.folders)&&scopeTabs();}
function folderRows(){return S.folders||[];}
function chosenFolder(){return foldersOn()&&S.projectFolder?folderRows().find(r=>r.folder===S.projectFolder)||null:null;}
function folderOfSpace(id){return folderRows().find(r=>r.workspace_id===id)||[...addedFolders.values()].find(r=>r.workspace_id===id)||null;}
function spaceName(id){return S.workspaces.find(w=>w?.id===id)?.name||folderOfSpace(id)?.name||'';}
// Returns whether the chosen folder's project changed (a first Pip made there since: the folder is a project now), so
// its caller reads that project's cards. A project this view has not heard of is read with the rest (list_workspaces),
// or the tab could not open it until the view was opened again.
async function loadFolders(){
 if(remoteHost||S.apiVersion<93||typeof S.projectFolder!=='string'&&S.apiVersion<ONE_API)return false;
 const was=chosenFolder()?.workspace_id||null;
 try{const value=await send('list_project_folders');
  S.folders=(Array.isArray(value?.folders)?value.folders:[]).filter(r=>record(r)&&typeof r.folder==='string'&&r.folder&&r.folder.length<=4096).slice(0,200)
   .map(r=>({folder:r.folder,shown:tildePath(r.folder),name:typeof r.name==='string'&&r.name?r.name.slice(0,200):folderLeaf(r.folder),here:r.here===true,exists:r.exists!==false,workspace_id:typeof r.workspace_id==='string'&&/^ws_[a-f0-9]{32}$/.test(r.workspace_id)?r.workspace_id:null}));
  if(S.workspaces.length&&S.folders.some(r=>r.workspace_id&&!S.workspaces.some(w=>w?.id===r.workspace_id))){
   const listed=await send('list_workspaces');if(Array.isArray(listed?.workspaces))S.workspaces=listed.workspaces;}}
 catch{/* no folders read: the tab is this window's project, as before, until they are */}
 return (chosenFolder()?.workspace_id||null)!==was;
}
// Needs attention's `projects` for the choice: every project's, one folder's workspace, or nothing (a folder with none).
function attentionProjects(){if(!foldersOn())return {};const row=chosenFolder();return row?(row.workspace_id?{projects:row.workspace_id}:{}):{projects:'all'};}
// The Project Pips' cards of the choice among what the list holds: every project's, or the chosen folder's own. The page
// itself decides this, not only what was asked of DGC: a list read for the choice before, or one a DGC answers with
// another project's cards in it, shows none of them here. A folder with no Pips workspace yet has no cards at all
// (it used to show whatever came back for a request that named no project).
function projectCards(page){
 const mine=personalSpace()?.id,row=chosenFolder(),theirs=(page?.items||[]).filter(i=>i.workspace_id!==mine);
 return row?(row.workspace_id?theirs.filter(i=>i.workspace_id===row.workspace_id):[]):theirs;
}
// Whether this place is the Project tab's (its cards, its count, its View all).
function projectPlace(){return onePips()?false:foldersOn()?scopeTab()==='project':projectHome();}
async function loadProjectsAll(){
 if(!foldersOn()||projectsAll.busy)return;const sequence=++projectsAll.seq;projectsAll.busy=true;
 try{const value=await send('list_pips',{scope:'projects',order:'recent',limit:100});if(sequence!==projectsAll.seq)return;
  projectsAll.pips=(Array.isArray(value?.pips)?value.pips:[]).filter(p=>record(p)&&typeof p.id==='string'&&/^pip_[a-f0-9]{32}$/.test(p.id)&&typeof p.name==='string'&&p.name&&typeof p.workspace_id==='string');projectsAll.error='';}
 catch(error){if(sequence!==projectsAll.seq)return;projectsAll.error=errorText(error);}
 projectsAll.read=true;projectsAll.busy=false;render();
}
// What the Project tab shows follows the choice, whatever was open before (a Pip opened from another folder, a choice
// made over the Work sessions): at the list of Pips, one folder's own list, or the page of All projects (or of a folder
// with no Pips) over whatever is loaded underneath. Looked at on every draw; a Pip that is open is left alone.
function settleProjectTab(){
 if(!foldersOn()||!S.workspace||S.switching||S.loading||S.review||S.busy||navigating)return;
 if(!((!S.selected||S.overview)&&!S.create)||!projectHome()&&!S.projectEmpty)return;
 const space=projectSpace();
 if(!space){S.projectEmpty=true;if(!chosenFolder()&&!projectsAll.read&&!projectsAll.busy)void loadProjectsAll();return;}
 if(S.workspace.id===space.id&&!S.projectEmpty)return;
 queueMicrotask(()=>{
  if(!foldersOn()||S.switching||S.review||S.busy||navigating||projectSpace()?.id!==space.id||S.workspace?.id===space.id&&!S.projectEmpty||!projectHome()&&!S.projectEmpty)return;
  const loading=enterWorkspace(space),epoch=S.epoch;S.switching=true;render();
  void loading.finally(()=>{if(epoch===S.epoch&&S.switching){S.switching=false;render();}});
 });
}
// The dropdown has a line of its own (asked 13 Nov), at the left, straight under the Personal | Project tabs and above
// Needs attention, whether or not anything waits: it is the Project tab's one control, and Needs attention, its count,
// its page of them all and the list of Project Pips all follow it. (On the Needs attention heading's line it read as
// that heading's own filter.) No line names one folder's path: the button's tooltip has it. Its element drops the
// "Project Folder" word when the line has no room for it with the folder's name.
function folderPickHere(){return foldersOn()&&scopeTab()==='project'&&!!globalThis.DgcFolderPick;}
function folderLineMarkup(){
 if(!folderPickHere())return '';
 const row=chosenFolder();
 return `<div class="pips-folder-line"><dgc-folder-fit class="pips-folder-fit">${globalThis.DgcFolderPick.buttonHtml({id:'pips-folder-pick',rows:folderRows(),choice:row?row.folder:''})}</dgc-folder-fit></div>`;
}
// All projects: every project's Pips, each with its folder under its name. A row opens that Pip here.
function projectsAllMarkup(){
 if(!projectsAll.read)return loadingMark();
 const Pick=globalThis.DgcFolderPick,rows=projectsAll.pips.filter(p=>p.status!=='archived');
 const row=p=>{const type=pipType(p,S.types)||characterType(p.pip_type),pose=presentation(p,[],usable(),S.runner),waiting=waitingOn(S.attention,p.id,pendingReviews(p)),place=folderOfSpace(p.workspace_id),name=place?.name||spaceName(p.workspace_id);
  return `<button type="button" class="pip-row pip-row-project${waiting?' pip-row-marked':''}" data-project-pip="${esc(p.id)}" data-state="${esc(pose.state)}" title="${esc(name?`${p.name} · ${name}`:p.name)}">${pipAvatar(p,pose.state,`all-${p.id}`,type)}<span class="pip-row-copy"><strong><span class="pip-row-name">${esc(p.name)}</span></strong><small class="pip-row-folder">${place&&Pick?`${place.exists?'':'<span class="pip-row-folder-note">Folder not found</span>'}${Pick.pathHtml(place.shown,place.folder)}`:esc(name||'A project on this computer')}</small></span>${waiting?`<span class="pip-row-marks"><span class="pip-row-count" role="img" aria-label="${waiting} waiting for you">${waiting}</span></span>`:''}</button>`;};
 return `<section class="simple-home pips-projects-all" aria-label="Every project’s Pips"><div class="simple-home-head"><h2>Project Pips</h2><span class="simple-home-actions">${windowSpace()?button('projects-new','New Pip',S.busy||!usable(),'primary pill'):''}</span></div>${projectsAll.error?`<p class="notice error" role="alert">${esc(projectsAll.error)}</p>`:''}${rows.length?`<div class="pip-rows pips-projects-list">${rows.map(row).join('')}</div>`:projectsAll.error?'':'<p class="muted">No Project Pips in any folder yet.</p>'}</section>`;
}
function openFolderMenu(button,keyboard){
 const Pick=globalThis.DgcFolderPick;if(!Pick)return;
 if(button.id==='pips-filter'){openOneFilter(button,keyboard);return;}
 if(button.id==='new-pip-folder'&&S.review?.onePip){
  if(button.getAttribute('aria-expanded')==='true'){Pick.close(true);return;}
  Pick.open(button,{rows:createFolderRows(),choice:draft.createFolder||'',all:true,allLabel:'No folder (Personal)',add:true,goneOff:true,label:'Folder',keyboard,trigger:()=>$('new-pip-folder'),
   onChoose:folder=>{draft.createFolder=folder;if(S.review?.onePip){S.review.error='';Object.assign(S.review,oneNewPipReview());renderReview();}$('new-pip-folder')?.focus({preventScroll:true});},
   onAdd:()=>void addCreateFolder()});
  return;
 }
 if(!foldersOn())return;
 if(button.getAttribute('aria-expanded')==='true'){Pick.close(true);return;}
 // Create a Project Pip: the form's own folder (never the list's choice), with Add a folder… at the end.
 if(button.id==='new-pip-folder'){
  Pick.open(button,{rows:createFolderRows(),choice:draft.createFolder||'',all:false,add:true,goneOff:true,keyboard,trigger:()=>$('new-pip-folder'),
   onChoose:folder=>{draft.createFolder=folder;if(S.review?.projectPip){S.review.error='';Object.assign(S.review,newProjectPipReview());renderReview();}$('new-pip-folder')?.focus({preventScroll:true});},
   onAdd:()=>void addCreateFolder()});
  return;
 }
 // The Project tab: the choice is the extension's to keep (every window, the Work sessions too); it says it back.
 const now=chosenFolder()?.folder||'';
 Pick.open(button,{rows:folderRows(),choice:now,all:true,keyboard,trigger:()=>$('pips-folder-pick'),onChoose:folder=>{if(folder!==now)options.postMessage({type:'pipsProjectFolderChoose',folder});}});
}
// The folders a new Project Pip can work in: this window's folder (listed or not), the ones DGC lists, the ones added here.
function createFolderRows(){
 const listed=folderRows(),own=S.windowFolder&&!listed.some(r=>r.folder===S.windowFolder.folder)?[{folder:S.windowFolder.folder,shown:tildePath(S.windowFolder.folder),name:S.windowFolder.name||folderLeaf(S.windowFolder.folder),here:true,exists:true,workspace_id:windowSpace()?.id||null}]:[];
 return [...own,...listed,...[...addedFolders.values()].filter(r=>!listed.some(x=>x.folder===r.folder)&&!own.some(x=>x.folder===r.folder))];
}
function newPipFolderField(){
 const Pick=globalThis.DgcFolderPick;if(!foldersOn()||!Pick)return '';
 const rows=createFolderRows(),row=rows.find(r=>r.folder===draft.createFolder);
 return `<div class="new-pip-folder">${Pick.buttonHtml({id:'new-pip-folder',rows,choice:row?row.folder:'',empty:'Choose a folder',title:row?row.folder:'Choose the folder this Pip works in'})}${row?`<p class="new-pip-folder-path" title="${esc(row.folder)}">${Pick.pathHtml(row.shown,row.folder)}</p>`:''}</div>`;
}
// Add a folder…: the editor's own folder picker (only a folder that exists), then DGC makes it a project
// (add_project_folder) and it is the form's folder. DGC's refusal (the home folder, DGC's own) shows in the form.
function pickFolder(){return new Promise(resolve=>{const id=`pick-${Date.now().toString(36)}-${++folderPickSeq}`;folderPicks.set(id,resolve);options.postMessage({type:'pipsPickFolder',id});});}
async function addCreateFolder(){
 const review=S.review;if(!(review?.projectPip||review?.onePip)||!usable())return;
 const folder=await pickFolder();if(!folder||S.review!==review)return;
 try{const added=await send('add_project_folder',{folder}),space=added?.workspace;
  if(!record(space)||typeof space.id!=='string'||!/^ws_[a-f0-9]{32}$/.test(space.id))throw Error('DGC didn’t say which project that folder is. Try again.');
  if(!S.workspaces.some(w=>w?.id===space.id))S.workspaces=[...S.workspaces,space];
  addedFolders.set(folder,{folder,shown:tildePath(folder),name:typeof space.name==='string'&&space.name?space.name.slice(0,200):folderLeaf(folder),here:false,exists:true,workspace_id:space.id});
  draft.createFolder=folder;review.error='';}
 catch(error){review.error=errorText(error);}
 if(S.review===review){Object.assign(review,review.onePip?oneNewPipReview():newProjectPipReview());renderReview();$('new-pip-folder')?.focus({preventScroll:true});}
}
function projectSpace(){
 if(!foldersOn())return windowSpace();
 const row=chosenFolder();return row?.workspace_id?S.workspaces.find(w=>w?.id===row.workspace_id&&w.kind!=='personal')||null:null;
}
function scopeTabs(){return !remoteHost&&!!personalSpace()&&!onePips();}
// ---- One Pips (0.52, his calls of 13 Nov; Pips API 94; src/pipsOne.js) ----
// One list for every Pip, where this page had Personal | Project tabs: Core pinned first, then the Pip with the latest
// message or report, as DGC lists them (list_pips {scope: "all"}); each row says where its Pip works. The line under
// the search chooses which show (All Pips · Personal · each folder), and Needs attention, its count and its page of
// them all follow it. Any Pip opens here, in the one page and chat. Personal stays loaded underneath (its settings,
// its teams and its new Pips are the home's own); a Pip of a folder is opened in its folder's project when it is
// chosen. An older DGC keeps the two tabs.
function onePips(){return !remoteHost&&S.apiVersion>=ONE_API&&!!personalSpace();}
const one={filter:ONE_ALL,pips:[],read:false,busy:false,error:'',seq:0,next:null,total:null,moreBusy:false,bumps:new Map(),held:null,drawn:null,hover:false,leave:0,asked:'',reportsSort:'new'};
const oneSeen=new Map();let oneSeenRead=false,oneBump=0;
function oneScope(){return {personalId:personalSpace()?.id||'',folders:S.folders||[]};}
// A Pip this view knows of, open or only listed.
function knownPip(id){return S.jobs.find(p=>p.id===id)||one.pips.find(p=>p.id===id)||null;}
function onePage(value){return (Array.isArray(value?.pips)?value.pips:[]).filter(p=>record(p)&&typeof p.id==='string'&&/^pip_[a-f0-9]{32}$/.test(p.id)&&typeof p.name==='string'&&p.name&&typeof p.workspace_id==='string'&&/^ws_[a-f0-9]{32}$/.test(p.workspace_id));}
async function loadOne(){
 if(!onePips()||!usable())return;
 const sequence=++one.seq,request=listRequest(one.filter,{...oneScope(),query:S.pipSearch});
 // A folder DGC has no Pips for yet: nothing to read, and the page says so.
 if(!request){one.pips=[];one.next=null;one.total=0;one.error='';one.read=true;one.busy=false;one.bumps.clear();render();return;}
 one.busy=true;
 try{const value=await send('list_pips',request);if(sequence!==one.seq)return;
  const pips=onePage(value);
  // DGC's order is the latest news now: what was moved up here meanwhile is in it.
  one.pips=pips.map(pipFresh);one.next=Number.isSafeInteger(value?.next_offset)?value.next_offset:null;one.total=Number.isSafeInteger(value?.total)?value.total:pips.length;one.error='';one.bumps.clear();}
 catch(error){if(sequence!==one.seq)return;one.error=errorText(error);}
 one.read=true;one.busy=false;render();
}
async function loadOneMore(){
 if(!onePips()||one.moreBusy||one.next===null||!usable())return;
 const sequence=one.seq,request=listRequest(one.filter,{...oneScope(),query:S.pipSearch,offset:one.next});if(!request)return;
 one.moreBusy=true;render();
 try{const value=await send('list_pips',request);if(sequence!==one.seq)return;
  const seen=new Set(one.pips.map(p=>p.id));one.pips=[...one.pips,...onePage(value).filter(p=>!seen.has(p.id))];
  one.next=Number.isSafeInteger(value?.next_offset)?value.next_offset:null;if(Number.isSafeInteger(value?.total))one.total=value.total;}
 catch(error){if(sequence===one.seq)setError(error);}
 finally{one.moreBusy=false;if(sequence===one.seq)render();}
}
// A Pip whose new message or report arrived (the unread counts just read say so) moves to the top at once; one that
// is not in the list yet is read with it.
function noteArrivals(){
 if(!onePips())return;
 let missing=false;
 for(const [pip,item] of unreadByPip){const mark=`${item.latest_message_id||''}|${item.latest_post_id||''}|${item.count}`;
  if(oneSeenRead&&oneSeen.get(pip)!==mark){if(one.pips.some(p=>p.id===pip))one.bumps.set(pip,++oneBump);else if(underFilter({workspace_id:item.workspace_id},one.filter,oneScope())&&!S.pipSearch)missing=true;}
  oneSeen.set(pip,mark);}
 oneSeenRead=true;if(missing)void loadOne();
}
function bumpPip(id){if(onePips()&&id&&one.pips.some(p=>p.id===id))one.bumps.set(id,++oneBump);}
// The list holds still while the pointer is over it or one of its rows has the keyboard.
function oneHeld(){const list=document.querySelector('.pips-one-list');return !!list&&(one.hover||list.contains(document.activeElement));}
function oneRelease(){if(one.held&&!oneHeld())render();}
function chooseOneFilter(value){
 const next=value===ONE_PERSONAL?ONE_PERSONAL:savedFilter(value,S.folders||[]);if(next===one.filter)return;
 one.filter=next;one.read=false;one.pips=[];one.next=null;one.total=null;one.held=null;one.drawn=null;one.bumps.clear();attentionRead=false;
 if(attentionAll.open)attentionAll.open=false;
 rememberView();render();void loadOne();void loadAttention();
}
function openOneFilter(button,keyboard){
 const Pick=globalThis.DgcFolderPick;if(!Pick||!onePips())return;
 if(button.getAttribute('aria-expanded')==='true'){Pick.close(true);return;}
 const now=one.filter;
 Pick.open(button,{rows:S.folders||[],choice:now,all:true,allLabel:'All Pips',lead:[{value:ONE_PERSONAL,name:'Personal',sub:'Pips with no folder'}],label:'Show',keyboard,trigger:()=>$('pips-filter'),onChoose:value=>{chooseOneFilter(value);$('pips-filter')?.focus({preventScroll:true});}});
}
function oneFilterMarkup(){
 const Pick=globalThis.DgcFolderPick;if(!Pick)return '';
 const folder=one.filter!==ONE_ALL&&one.filter!==ONE_PERSONAL;
 return `<div class="pips-one-filter">${Pick.buttonHtml({id:'pips-filter',cls:'pips-filter',rows:S.folders||[],choice:folder?one.filter:'',label:'Show',empty:'All Pips',said:one.filter===ONE_PERSONAL?'Personal':''})}</div>`;
}
// A folder as its way there and its own name: in a narrow list the way there gives way, and the name stays whole.
function placeWords(shown){const at=Math.max(shown.lastIndexOf('/'),shown.lastIndexOf('\\'));return at>=0&&at<shown.length-1?`<span class="pip-row-place-dir">${esc(shown.slice(0,at+1))}</span><span class="pip-row-place-name">${esc(shown.slice(at+1))}</span>`:esc(shown);}
// Where a Pip works, said first under its name: "Personal", or its folder (the whole path is its tooltip).
function onePlaceMarkup(p){
 const place=placeOf(p,{personalId:personalSpace()?.id||'',folderOf:folderOfSpace,nameOf:spaceName});
 if(place.kind==='unknown')return '';
 return `<span class="pip-row-place" data-place="${place.kind}" title="${esc(place.full)}">${place.missing?'<span class="pip-row-folder-note">Folder not found</span> ':''}${placeWords(place.shown)}</span><span class="pip-row-sep" aria-hidden="true"> · </span>`;
}
function oneHomeMarkup(){
 const scopeNow=oneScope(),searching=!!S.pipSearch,folder=one.filter!==ONE_ALL&&one.filter!==ONE_PERSONAL?(S.folders||[]).find(r=>r.folder===one.filter)||null:null;
 const shown=one.pips.filter(p=>S.showArchived||p.status!=='archived'),ordered=orderPips(shown,{personalId:scopeNow.personalId,bumps:one.bumps});
 // Held still, the rows keep the places they were drawn in; let go, they take the latest order.
 if(!document.querySelector('.pips-one-list'))one.hover=false;
 if(oneHeld()){if(!one.held)one.held=one.drawn||ordered.map(p=>p.id);}else one.held=null;
 const rows=heldOrder(ordered,one.held);one.drawn=rows.map(p=>p.id);
 const count=one.total!==null&&(one.total>one.pips.length||searching)?`<small class="pip-search-count">${searching?`${one.total.toLocaleString('en-US')} found`:`Showing ${one.pips.length.toLocaleString('en-US')} of ${one.total.toLocaleString('en-US')}`}</small>`:'';
 const search=`<div class="pip-search pips-one-search"><label class="sr-only" for="pip-search">Search your Pips</label><input id="pip-search" type="search" placeholder="Search your Pips" autocomplete="off" value="${esc(draft.pipSearch||'')}" maxlength="120">${count}</div>`;
 const hasCore=one.pips.some(p=>p.pip_type==='core'&&p.workspace_id===scopeNow.personalId);
 // With no Pips at all (and nothing typed), Core is met first, as before.
 if(one.read&&!one.error&&!one.pips.length&&!searching&&one.filter===ONE_ALL&&S.jobsRead&&!S.jobs.length)return `${search}${oneFilterMarkup()}${attentionHomeMarkup()}${meetCoreMarkup()}`;
 const empty=!one.read?loadingMark():one.error?'':searching?`<p class="muted pips-one-none">No Pip matches “${esc(S.pipSearch)}” in its name, instructions or chat.</p>`
  :folder?`<p class="muted pips-one-none">No Pips in ${esc(folder.name)} yet.</p>`:one.filter===ONE_PERSONAL?'<p class="muted pips-one-none">No Pips without a folder yet.</p>':'<p class="muted pips-one-none">No Pips yet.</p>';
 const list=rows.length?`<div class="pip-rows pips-one-list">${rows.map(p=>homeRowSlot(p,onePlaceMarkup(p))).join('')}</div>`:empty;
 const coreOffer=one.read&&!hasCore&&!searching&&!folder&&rows.length?`<div class="core-offer">${avatar('idle',characterType('core'),'core-offer')}<p><strong>Meet Core</strong><span>Your Primary Pip, for everyday tasks.</span></p>${button('create-core','Create',S.busy||!usable(),'primary pill')}</div>`:'';
 const more=one.next!==null?button('one-more',one.moreBusy?'Loading…':'Load more',one.moreBusy||!usable(),'link'):'';
 const archivedCount=one.pips.filter(p=>p.status==='archived').length;
 const head=`<div class="simple-home-head"><h2>Your Pips</h2><span class="simple-home-actions"><button type="button" id="pips-settings-open" class="topbar-icon" aria-label="Pips settings" title="Pips settings: computers, apps and plugins"${!usable()?' disabled':''}>${simpleIcon('gear')}</button>${S.workspace?.kind==='personal'?teamMenuMarkup():''}${button('simple-new','New Pip',S.busy||!usable(),'primary pill')}</span></div>`;
 return `${search}${oneFilterMarkup()}${searching?'':attentionHomeMarkup()}<section class="simple-home pips-one-home" aria-label="Your Pips">${head}${one.error?`<p class="notice error" role="alert">${esc(one.error)}</p>`:''}${coreOffer}${list}${more}${archivedCount?button('show-archived',S.showArchived?'Hide archived':'Show archived',false,'link'):''}</section>${searching||S.workspace?.kind!=='personal'?'':flowMarkup()}`;
}
// A row opens its Pip, whichever folder it works in: one of the project loaded underneath at once, another's by way
// of its own project (navigateFromHost reads it and opens it there).
function openOnePip(id){
 one.hover=false;
 if(S.jobs.some(p=>p.id===id)&&!S.switching){void select(id);return;}
 void navigateFromHost({pip:id}).catch(error=>setError(error));
}
// Back at the list: Personal is what is loaded under it (the home's settings, teams and new Pips are Personal's).
function oneHomeAgain(){
 const personal=personalSpace();void loadOne();
 if(personal&&S.workspace&&S.workspace.id!==personal.id&&!S.busy)void enterWorkspace(personal);
}
function scopeTab(){return S.projectEmpty||S.workspace?.kind!=='personal'?'project':'personal';}
// The workspaces this view may open: with tabs, Personal and this folder's project (with the Project Folder dropdown,
// any project's: a Project Pip from another folder opens here); without, every one, as before.
function openableSpaces(){return scopeTabs()&&!foldersOn()?[personalSpace(),projectSpace()].filter(Boolean):S.workspaces;}
// A number means something needs you, and it's the number Needs attention says; a dot means there's something new to read.
// With neither, nothing. An older DGC has no such number, so it never gets one here. Nothing shows until that list has been
// read, so a dot never stands in for a number that is on its way.
function scopeTabsMarkup(){
 if(!scopeTabs())return '';
 const chosen=scopeTab(),project=projectSpace();
 const tab=(key,label,title,workspace,need)=>{
  const fresh=attentionRead&&workspace?unreadTotals.get(workspace.id)||0:0,count=attentionRead?need:0,said=needWords(count,fresh);
  const mark=count?`<span class="pip-tab-count" aria-hidden="true">${count.toLocaleString('en-US')}</span>`:fresh?'<span class="pip-tab-new" aria-hidden="true"></span>':'';
  return `<button type="button" role="tab" id="pips-tab-${key}" class="pips-tab" data-pips-tab="${key}" aria-controls="pips-tabpanel" aria-selected="${chosen===key}"${chosen===key?'':' tabindex="-1"'} title="${esc(said?`${said}\n${title}`:title)}"${said?` aria-label="${esc(`${label}, ${said}`)}"`:''}>${label}${mark}</button>`;};
 // With the Project Folder dropdown the list holds the chosen projects' cards too: each tab counts its own.
 if(foldersOn()){const mine=personalSpace()?.id,others=(S.attention?.items||[]).filter(i=>i.workspace_id!==mine).length,theirs=projectCards(S.attention).length,row=chosenFolder();
  return `<div class="pips-tabs" role="tablist" aria-label="Your Pips, or your projects’ Pips">${tab('personal','Personal','Your Pips: the same in every folder',personalSpace(),Math.max(0,(S.attention?.total||0)-others))}${tab('project','Project',row?`${row.name}: this folder’s Pips`:'Every project’s Pips',project,theirs)}</div>`;}
 return `<div class="pips-tabs" role="tablist" aria-label="Your Pips, or this project’s Pips">${tab('personal','Personal','Your Pips: the same in every folder',personalSpace(),S.attention?.total||0)}${tab('project','Project',project?`${project.name}: this project’s Pips`:'Open a project folder to see its Pips',project,project&&S.attention?.projects?.[project.id]?.total||0)}</div>`;
}
// What the chosen tab shows is its panel (the list, or a Pip open in it).
function scopePanelAttrs(){return scopeTabs()?` id="pips-tabpanel" role="tabpanel" aria-labelledby="pips-tab-${scopeTab()}"${S.switching?' aria-busy="true"':''}`:'';}
function projectEmptyMarkup(){
 if(!foldersOn())return `<div class="pips-tab-empty"${scopePanelAttrs()}><p class="muted">Open a project folder to see its Pips.</p></div>`;
 const row=chosenFolder();
 // One folder with no Pips says so; All projects is every project's Pips, under what waits on them.
 if(row)return `<div class="simple-content pips-folder-page"${scopePanelAttrs()}>${folderLineMarkup()}<div class="pips-tab-empty"><p class="muted">No Project Pips in ${esc(row.name)} yet.</p></div></div>`;
 return `<div class="simple-content pips-folder-page"${scopePanelAttrs()}>${folderLineMarkup()}${attentionHomeMarkup()}${projectsAllMarkup()}</div>`;
}
/** Shows another workspace's Pips from the top: what the old dropdown did, and what opening a Pip elsewhere does. */
// Its list starts at its first page: the pages read and the search typed were the other tab's (both tabs are paged now).
function enterWorkspace(target){S.epoch++;clearSelection();S.selected='';S.jobs=[];S.jobsRead=false;jobsExtra=[];S.jobsNext=null;S.jobsTotal=null;window.clearTimeout(pipSearchTimer);S.pipSearch='';draft.pipSearch='';S.context=null;S.create=false;S.overview=true;S.workspace=target;S.projectEmpty=false;S.switching=false;setupRows=[];setupError='';S.error='';rememberView();return refresh(true);}
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
const simpleIcon=name=>`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{back:'<path d="M10 3 5 8l5 5"/>',computer:'<rect x="2" y="2.5" width="12" height="8.5" rx="1.5"/><path d="M6 14h4M8 11v3"/>',more:'<circle cx="3.5" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.5" cy="8" r=".6"/>',share:'<path d="M8 2v8M5 5l3-3 3 3"/><path d="M3 9v4h10V9"/>',gear:'<path d="M2 4h6.5M12 4h2M2 8h2M7.5 8H14M2 12h8.5M14 12h0"/><circle cx="10" cy="4" r="1.6"/><circle cx="5.5" cy="8" r="1.6"/><circle cx="12" cy="12" r="1.6"/>',plus:'<path d="M8 3v10M3 8h10"/>',play:'<path d="M5.5 3.5v9l7-4.5z"/>'}[name]}</svg>`;
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
S.attention=null;let attentionSeq=0,attentionExpanded=false,attentionRead=false;
// Needs attention opens when something is in it; folded by you, it stays folded until something new arrives (his call,
// 11 Nov). What was in it when you folded it is kept, here and in the saved view.
// With the Project Folder dropdown the list holds Project Pips' cards too: Personal's on the Personal tab, the chosen
// projects' on the Project tab. Without it a project's home shows none of the list, as before.
function attentionPart(page){
 if(onePips())return attentionFor(page,one.filter,oneScope());
 if(!foldersOn())return projectHome()?null:page;if(!page)return page;
 const project=scopeTab()==='project',items=project?projectCards(page):page.items.filter(i=>i.workspace_id===personalSpace()?.id);
 // (A folder with no Pips workspace has nothing waiting, whatever the list holds: its number is 0.)
 return {...page,items,total:project&&chosenFolder()&&!chosenFolder().workspace_id?0:Math.max(items.length,page.total-(page.items.length-items.length))};
}
function attentionKeys(){return [...(attentionPart(S.attention)?.items||[]).map(i=>i.id),...setupRows.filter(r=>!heldRejects.has(r.id)).map(r=>'setup:'+r.id)];}
function attentionOpen(){
 const keys=attentionKeys();if(!keys.length)return attentionExpanded;
 // What came in while it was folded is what it opens on.
 if(attentionUserFolded){const fresh=keys.find(k=>!attentionFolded.has(k));if(!fresh)return false;attentionUserFolded=false;attentionFolded.clear();attentionPlace().key=fresh;rememberView();}
 return attentionExpanded||1;
}
// One card in view (asked 11 Nov: the list "gets too long"): the card you are on, kept by what it is, so a new card
// arriving moves nothing, and an answered one gives its place to the next. Personal and Project each keep their own.
const attentionPlaces={personal:{key:'',index:0},project:{key:'',index:0}};
function attentionPlace(){return attentionPlaces[projectPlace()?'project':'personal'];}
function attentionShowing(cards){
 const place=attentionPlace(),keys=cards.map(c=>c.key);if(!keys.length)return 0;
 place.index=attentionSpot(keys,place.key,place.index);place.key=keys[place.index];return place.index;
}
const attentionStill=()=>!window.matchMedia||window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let attentionSettle=0;
// To another card: it slides in from the side you are going to, and the section's height follows it (about 180 ms;
// neither under reduced motion). `focus` keeps the keyboard in the carousel when what held it is gone or off.
function attentionGo(key,index,{focus=false}={}){
 const old=document.querySelector('.attention-carousel'),from=Number(old?.dataset.at);if(!old||!key)return;
 const place=attentionPlace();if(place.key===key)return;
 const held=focus?document.activeElement?.id||'':'',was=old.querySelector('.attention-stage')?.getBoundingClientRect?.().height||0;
 place.key=key;place.index=Number.isSafeInteger(index)?index:place.index;renderThenFocus();
 const now=document.querySelector('.attention-carousel'),stage=now?.querySelector('.attention-stage');if(!stage)return;
 if(focus&&!now.contains(document.activeElement))(held&&!$(held)?.disabled&&$(held)||now.querySelector('.attention-dot[aria-current]'))?.focus?.({preventScroll:true});
 if(attentionStill())return;
 const to=stage.getBoundingClientRect().height;window.clearTimeout(attentionSettle);
 stage.classList.add('attention-moving',Number(now.dataset.at)<from?'attention-from-prev':'attention-from-next');
 if(was&&Math.abs(to-was)>=1){stage.style.height=was+'px';void stage.offsetHeight;stage.style.height=to+'px';}
 attentionSettle=window.setTimeout(()=>{stage.classList.remove('attention-moving','attention-from-prev','attention-from-next');stage.style.height='';},220);
}
// One card along, by a key or a swipe: way is -1 or 1. At an end, nothing.
function attentionStep(way,how){const b=$(way<0?'attention-prev':'attention-next');if(b&&!b.disabled)attentionGo(b.dataset.attentionGo,Number(b.dataset.attentionIndex),how);}
// Reject on a new Pip's card turns it down at once everywhere (his call, 11 Nov), held for a moment so a slip can be
// undone: the card goes, "Rejected · Undo" shows, and the reject is sent when the moment passes. A window closed
// meanwhile sends nothing, so the new Pip just waits again.
function rejectSoon(id,fire){
 if(heldRejects.has(id))return;
 const timer=window.setTimeout(()=>{heldRejects.delete(id);if(S.undoReject===id)S.undoReject='';void fire().finally(()=>render());},REJECT_HOLD_MS);
 heldRejects.set(id,timer);S.undoReject=id;S.notice='';render();
}
function undoReject(id){const timer=heldRejects.get(id);if(timer===undefined)return;window.clearTimeout(timer);heldRejects.delete(id);if(S.undoReject===id)S.undoReject='';render();}
function undoRejectMarkup(){return S.undoReject&&heldRejects.has(S.undoReject)?`<p class="notice simple-note undo-reject" role="status">Rejected. No Pip was created. <button type="button" class="link" data-undo-reject="${esc(S.undoReject)}">Undo</button></p>`:'';}
async function rejectSetupNow(id){
 // Its digest is read again first, as the turn-down page did; the reject goes even if you moved on meanwhile.
 try{const answer=await send('get_pip_setup',{setup_id:id});const setup=pipSetup(answer.setup,answer.setup?.workspace_id||S.workspace.id,id);
  if(setup.status!=='pending')throw Error('This setup was already answered. Refresh Pips.');
  await send('reject_pip_setup',{setup_id:setup.id,expected_digest:setup.digest});setupRows=setupRows.filter(row=>row.id!==setup.id);}
 catch(error){setError(error);}
 finally{void loadSetups();void loadAttention();}
}
async function loadAttention(){
 // Its list is Personal Pips' cards, and a project's home shows none of it, but both tabs say their number from this page.
 if(remoteHost||S.apiVersion<44||!simpleMode()||!usable()){attentionRead=true;return;}
 const token=scope(),sequence=++attentionSeq,first=!attentionRead;
 try{const page=attentionPage(await send('list_pip_attention',{limit:100,...(onePips()?attentionRequest(one.filter,oneScope()):attentionProjects())}));if(token!==scope()||sequence!==attentionSeq)return;
  const before=JSON.stringify(S.attention),fresh=first||JSON.stringify(page)!==before;S.attention=page;attentionRead=true;if(fresh){render();void loadAttentionVisits(page,token);}}
 catch{/* the home still lists every Pip; the next refresh tries again */if(token===scope()&&!attentionRead){attentionRead=true;render();}}
}
// A card's own answers (asked 12 Nov), the ones Home offers for the same thing (src/pipCardAnswers.js): a Pip's change
// to itself (Apply / Not now) and its visit to a new site (Allow / Not now). An answer is held for a moment, as Home
// holds it and as Reject on a new Pip is: the card says what it will do with Undo, nothing is sent, and it goes when
// the moment passes. A window closed meanwhile sends nothing, so the thing just waits again.
const heldAnswers=new Map(),sentAnswers=new Set();let attentionVisits=new Map();
// The held visits to a new site among what waits, read after the list is drawn: a card opens until its answer is known.
async function loadAttentionVisits(page,token){
 const pips=[...new Set(page.items.filter(i=>i.kind==='computer_action'&&i.pip_id).map(i=>i.pip_id))].slice(0,8);
 const found=pips.length?await readVisits(send,pips):new Map();
 if(token!==scope()||S.attention!==page)return;
 const before=JSON.stringify([...attentionVisits]);attentionVisits=found;if(JSON.stringify([...found])!==before)render();
}
function attentionAnswer(item){
 if(!item?.pip_id||remoteHost)return null;
 const job=knownPip(item.pip_id),pip={id:item.pip_id,name:job?.name||item.pip_name||'It',version:job?.current_version||0};
 const answer=answerFor(item,pip,{visits:attentionVisits});return answer?{answer,pip}:null;
}
function answerSoon(id,yes){
 const item=S.attention?.items.find(i=>i.id===id),found=attentionAnswer(item);if(!found||heldAnswers.has(id)||sentAnswers.has(id)||!usable())return;
 const seen=attentionVisits.get(item.card)||null;
 const timer=window.setTimeout(()=>{
  heldAnswers.delete(id);if(!usable()){render();return;}
  sentAnswers.add(id);render();
  // Sent once; the list is read again either way, and one DGC did not take comes back.
  void sendItemAnswer(send,{answer:found.answer,item,pip:found.pip,seen},yes).catch(setError)
   .finally(()=>{void Promise.resolve(loadAttention()).finally(()=>{sentAnswers.delete(id);render();});void refresh(false);});
 },REJECT_HOLD_MS);
 heldAnswers.set(id,{timer,said:yes?found.answer.said.yes:found.answer.said.no});S.notice='';render();
 $('attention-undo'+attentionTail(item))?.focus?.({preventScroll:true});
}
function undoAnswer(id){const held=heldAnswers.get(id);if(!held)return;window.clearTimeout(held.timer);heldAnswers.delete(id);render();const tail=attentionTail(S.attention?.items.find(i=>i.id===id));($('attention-yes'+tail)||$('attention-open'+tail))?.focus?.({preventScroll:true});}
// What Needs attention draws, for its one card and for the page of them all: the cards of this place and how each is
// drawn. `all`: the page, where a new Pip just rejected keeps its place (it says so there, with Undo) until it is sent.
function attentionScene(all=false){
 const face=i=>{if(!i.pip_id)return '<span class="attention-mark" aria-hidden="true">+</span>';
  const current=knownPip(i.pip_id),pip=current||{id:i.pip_id,name:i.pip_name,pip_type:i.pip_type,workspace_id:i.workspace_id};
  return pipAvatar(pip,'waiting_approval',`attn-${i.card}`,characterType(pip.pip_type));};
 // A project's home shows none of the Personal Pips' rows: only the new Pips waiting in this project.
 const more=setupRows.length>=5?'Showing 5 new Pips. Answer one to see more.':'';
 // A new Pip you just rejected (held a moment for Undo) is out of the cards, the dots and the count at once.
 // (So is a card whose answer was just sent, until the list read after it says what became of it.)
 const gone=id=>!all&&heldRejects.has(id);
 // (A code to type says so, "Type the code for <site>": DGC's list calls every held step of a computer a form to send.)
 const held=page=>{if(!page)return page;const items=page.items.filter(i=>!(i.kind==='setup'&&gone(i.card))&&!sentAnswers.has(i.id)).map(i=>codeRow(i,attentionVisits));return {...page,items,total:Math.max(items.length,page.total-(page.items.length-items.length))};};
 // (Over the page of All projects the new Pips read are those of whatever is loaded underneath: not this place's.)
 const page=held(attentionPart(S.attention)),setups=S.apiVersion>=23&&!(foldersOn()&&S.projectEmpty)?setupRows.filter(r=>!gone(r.id)):[];
 const mine=personalSpace()?.id;
 return {page,setups,draw:{esc,face,busy:!usable(),setups,setupCard:setupCardFor,error:setupRows.length?setupError:'',more,
  // A Project Pip's card names its project.
  place:i=>(foldersOn()||onePips())&&i.workspace_id!==mine?spaceName(i.workspace_id):'',
  answers:i=>attentionAnswer(i)?.answer||null,held:i=>heldAnswers.get(i.id)?.said||''}};
}
function attentionHomeMarkup(){
 const {page,setups,draw}=attentionScene(),expanded=attentionOpen();
 return attentionMarkup(page,{...draw,expanded,at:attentionShowing(attentionCards(page,setups)),viewAll:true});
}
// "View all" (asked 12 Nov): Needs attention on a page of its own, every card of this place (Personal or Project) one
// under another, each with the answers its one card has. It scrolls as the view does. Back, or Escape, returns to the
// list of Pips with Needs attention on the card you were last on here (or the one you opened it from). Kept for this
// window only: a reload opens the list.
const attentionAll={open:false,place:'',last:'',lastIndex:0,homeScroll:0};
// What scrolls the view: the side bar's own root; in a tab its body, or the page itself where that is what scrolls.
const attentionScroller=()=>{if(embedded)return shell;const page=owner.scrollingElement;return page&&page!==shell&&(page.scrollTop>0||page.scrollHeight>page.clientHeight+1)?page:shell;};
// A row's buttons are named by its card on the page of them all, where many rows are drawn; '' for the one card.
function attentionTail(item){return attentionAll.open&&item?'-'+item.card:'';}
function attentionAllShown(){
 if(attentionAll.open&&attentionAll.place!==(projectPlace()?'project':'personal'))attentionAll.open=false;   // another place's cards: its list instead
 return attentionAll.open&&(!S.selected||S.overview)&&!S.create&&!(S.projectEmpty&&scopeTabs()&&!foldersOn());
}
function openAttentionAll(){
 Object.assign(attentionAll,{open:true,place:projectPlace()?'project':'personal',last:'',lastIndex:0,homeScroll:attentionScroller().scrollTop||0});
 renderThenFocus();attentionScroller().scrollTop=0;$('attention-all-back')?.focus?.({preventScroll:true});
}
function closeAttentionAll(){
 if(!attentionAll.open)return;attentionAll.open=false;
 // The card you were last on; one answered meanwhile gives its place to the next (attentionSpot).
 const place=attentionPlaces[attentionAll.place];if(place&&attentionAll.last){place.key=attentionAll.last;place.index=attentionAll.lastIndex;}
 renderThenFocus();attentionScroller().scrollTop=attentionAll.homeScroll;($('attention-view-all')||document.querySelector('.attention-toggle'))?.focus?.({preventScroll:true});
}
function attentionAllPageMarkup(notes){
 const {page,draw}=attentionScene(true),drawn=attentionAllMarkup(page,{...draw,rejected:id=>heldRejects.has(id)});
 return `<header class="pip-topbar"><button type="button" id="attention-all-back" class="topbar-icon" data-attention-all-back="1" aria-label="Your Pips" title="Your Pips">${simpleIcon('back')}</button><div class="pip-pill settings-pill"><span>Needs attention</span>${drawn.count?`<span class="attention-all-count" aria-label="${esc(`${drawn.count.toLocaleString('en-US')} waiting for you`)}">${drawn.count.toLocaleString('en-US')}</span>`:''}</div><span></span></header>${notes}<div class="simple-content" data-view="attention-all">${drawn.html}</div>`;
}
// A redraw of the page keeps what you are looking at where it is: a card arriving above it (the newest come first)
// moves nothing on screen. The first card in sight is found again after the draw and the view is put back on it; at
// the very top the page stays at its top, where the new card shows.
function attentionAllAnchor(){
 const view=attentionScroller();if(!attentionAll.open||!view.scrollTop)return null;
 const top=embedded?shell.getBoundingClientRect().top:0;
 for(const li of document.querySelectorAll('.attention-all-list>[data-attention-key]')){const b=li.getBoundingClientRect();if(b.bottom>top)return {key:li.dataset.attentionKey,top:b.top,scroll:view.scrollTop};}
 return null;
}
function keepAttentionAllScroll(anchor){
 if(!anchor||!attentionAll.open)return;
 const li=[...document.querySelectorAll('.attention-all-list>[data-attention-key]')].find(e=>e.dataset.attentionKey===anchor.key);
 const view=attentionScroller();
 if(li){const moved=li.getBoundingClientRect().top-anchor.top;if(Math.abs(moved)>=1)view.scrollTop+=moved;}
 else if(view.scrollTop!==anchor.scroll)view.scrollTop=anchor.scroll;
}
// What it remembers (#6): its notes about you, on its page and under the reply that kept them.
S.notes=null;S.notesPip='';S.notesError='';let notesSeq=0,notesBusy=false,noteConfirmAll=false;
async function loadNotes(){
 if(remoteHost||S.apiVersion<44||!keepsAll()||!usable())return;
 const token=scope(),pip=S.selected,sequence=++notesSeq;
 try{const notes=notesPage(await send('list_pip_notes',{pip_id:pip,...sharedNotes()}),pip);if(token!==scope()||sequence!==notesSeq||S.selected!==pip)return;
  const before=S.notesPip===pip?JSON.stringify(S.notes):'';S.notes=notes;S.notesPip=pip;S.notesError='';if(JSON.stringify(notes)!==before)render();}
 catch(error){if(token===scope()&&sequence===notesSeq){S.notesError=errorText(error);render();}}
}
// Pips API 46: a Pip's page lists, and forgets, what it kept in your one memory in DGC too (mem_ ids).
function sharedNotes(){return S.apiVersion>=46?{shared:true}:{};}
async function noteCall(type,fields,notice){
 if(notesBusy||!usable()||!keepsAll())return;const token=scope(),pip=S.selected;notesBusy=true;S.notesError='';render();
 try{const notes=notesPage(await send(type,{pip_id:pip,...fields,...sharedNotes()}),pip);if(token!==scope()||S.selected!==pip)return;S.notes=notes;S.notesPip=pip;S.notice=notice();}
 catch(error){if(token===scope())S.notesError=errorText(error);}
 finally{notesBusy=false;if(token===scope())render();}
}
// Under the reply that kept them, for good: drawn at the chat's end it sat below the next prompt and the Pip's
// Thinking row, read as the newest thing, and went when a newer reply came (his picture, 15 Nov). A run's notes go
// under its last reply only.
function memoryKept(m,shown){
 if(m.role!=='assistant'||!m.run_id||S.apiVersion<44||!keepsAll()||S.notesPip!==S.selected||!S.notes?.length)return '';
 const lastOfRun=shown.findLast(x=>x.role==='assistant'&&x.run_id===m.run_id);
 return lastOfRun===m?keptMarkup(S.notes,m.run_id,{esc,busy:notesBusy||!usable()}):'';
}
// "Knows about you" (Pips API 96, pips-flow-design Q8; dgc/pip_knows_you.py): what DGC remembers about you reaches this
// Pip, on by default; the switch beside "What it remembers" turns it off for this Pip. get_pip says `knows_you`.
const knowsState={pip:'',busy:false,error:''};
function knowsYou(){
 if(remoteHost||S.apiVersion<FLOW_API||typeof S.pip?.knows_you!=='boolean')return null;
 const mine=knowsState.pip===S.selected;
 return {on:S.pip.knows_you,busy:mine&&knowsState.busy,error:mine?knowsState.error:''};
}
async function setKnowsYou(on){
 if(knowsState.busy||!usable()||!knowsYou())return;const token=scope(),pip=S.selected,name=S.pip?.name||'This Pip';
 knowsState.pip=pip;knowsState.busy=true;knowsState.error='';render();
 try{const value=await send('set_pip_knows_you',{pip_id:pip,on});if(token!==scope()||S.selected!==pip)return;
  if(!record(value)||value.pip_id!==pip||typeof value.knows_you!=='boolean')throw Error('The switch didn’t save. Refresh to try again.');
  S.pip={...S.pip,knows_you:value.knows_you};
  S.notice=value.knows_you?`${name} knows what DGC remembers about you again.`:`${name} no longer gets what DGC remembers about you. It keeps what you told it here.`;}
 catch(error){if(token===scope()&&S.selected===pip)knowsState.error=errorText(error);}
 finally{knowsState.busy=false;if(token===scope()){render();keepFocus('pipKnowsYou');}}
}
// "Sent to the web" (Pips API 96, leak guard 4; src/pipSent.js): a row on its page; one click reads and shows what its
// computer sent, and to which sites. Nothing is read, and nothing is marked, until it is opened.
const sentState={pip:'',open:false,value:null,error:'',seq:0};
function resetSent(){sentState.pip='';sentState.open=false;sentState.value=null;sentState.error='';sentState.seq++;}
function sentSection(off){
 if(remoteHost||S.apiVersion<FLOW_API||!S.pip||archived())return '';
 return sentMarkup(sentState.pip===S.selected?sentState:null,{esc,busy:!usable()});
}
async function toggleSent(){
 if(!usable()||!S.selected)return;
 if(sentState.pip===S.selected&&sentState.open){sentState.open=false;sentState.seq++;render();keepFocus('pip-sent-toggle');return;}
 const token=scope(),pip=S.selected,sequence=++sentState.seq;
 sentState.pip=pip;sentState.open=true;sentState.value=null;sentState.error='';render();keepFocus('pip-sent-toggle');
 try{const value=sentPage(await send('list_pip_sent',{pip_id:pip}),pip);if(token!==scope()||sequence!==sentState.seq||S.selected!==pip)return;sentState.value=value;}
 catch(error){if(token===scope()&&sequence===sentState.seq)sentState.error=errorText(error);}
 finally{if(token===scope()&&sequence===sentState.seq)render();}
}
// Memory that learns (Pips API 57): its own working notes and its daily log, on its page; /learn in its chat.
S.workingNotes=null;S.workingNotesPip='';S.workingNotesError='';S.dailyLog=null;S.dailyLogPip='';S.dailyLogError='';S.learn=null;
let workingNotesSeq=0,workingNotesBusy=false,workingNotesEditing=false,dailyLogSeq=0;
const workingNotesShown=()=>S.apiVersion>=57&&!remoteHost&&keepsAll();
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
// Several computers (Pips API 79): how many it has, and one more, up to its limit. Its conversations share them.
function computersRowMarkup(off){
 if(S.apiVersion<79||remoteHost)return '';
 if(computerState.pip!==S.selected&&!computerState.loading)void loadComputer();
 const have=pipComputers();if(!have)return '';
 const full=have.have>=have.limit;
 return `</div><div class="pip-page-row static" data-computers="${have.have}"><span class="row-words"><strong>Computers: ${have.have}</strong><small>${full?`${have.limit} is the most it can have. `:''}Its computers are shared by all its conversations.</small></span>${button('add-computer','Add another',off||full,'quiet')}${computerNamesRow(off)}`;
}
// Under "Computers: N" (Pips API 86): each one's name, with Rename.
function computerNamesRow(off){
 const names=pipComputerNames(),ui=computerUi();if(!names)return '';
 const page=ui.place==='page';
 return computerNamesMarkup({esc,names,renaming:page?ui.renaming:0,renameText:ui.renameText,busy:!!off||ui.busy,error:page?ui.error:''});
}
function computerRowMarkup(p,off){
 if(S.apiVersion<42||remoteHost||!(personalPip()||folderBox())||archived())return '';
 // A Pip with a folder has the computer DGC gave it: it is opened here, never removed.
 if(!personalPip())return `<section class="pip-page-group" aria-label="Computer"><div class="pip-page-row static"><span class="row-words"><strong>Its own computer${infoTip('pipComputerSays','Its own computer',`A browser, a Terminal and its own copy of your folder, separate from yours. What ${esc(p.name)} changes there comes back to you as a card.`)}</strong></span><button type="button" class="quiet" data-flow-watch="page"${off?' disabled':''}>Open</button></div></section>`;
 return `<section class="pip-page-group" aria-label="Computer"><div class="pip-page-row static"><span class="row-words">${p.computer_plan
  ?`<strong>Its own computer${infoTip('pipComputerSays','Its own computer',`A browser, a Terminal and files, separate from yours. It starts when ${esc(p.name)} needs it.`)}</strong></span>${button('remove-computer','Remove…',off,'quiet')}`+computersRowMarkup(off)
  :`<strong>Computer${infoTip('pipComputerSays','Computer',`Give ${esc(p.name)} its own computer, so it can look things up and fill in forms for you.`)}</strong></span>${button('give-computer','Give it a computer…',off,'quiet')}`}</div></section>`;
}
// What this Pip can do: the shield's dialog, now also the level menu's last row.
function openWhatItCanDo(){if(!S.pip)return;openReview({title:`What ${S.pip.name} can do`,description:personalPip()?(S.pip.computer_plan?`${S.pip.name} has its own computer: ${S.apiVersion>=54?'a desktop with a browser, apps and a Terminal that reach public websites, and files':'a browser, a Terminal that reaches public websites, and files'}. It can also read the apps you connected. ${levelState.pip===S.pip.id&&levelState.value&&levelState.value.level!=='ask'?levelNotice(levelState.value):'Anything it would send, submit or change waits for your Allow, unless you chose Always allow.'}${S.apiVersion>=44?(carefulState.pip===S.pip.id&&carefulState.value?.careful===false?' Careful mode is off.':' Careful mode: it asks before it opens a new site, and before anything it read from your apps goes onto a website.'):''}`:`${S.pip.name} reads what you share here and the apps you connected. It can’t send, buy or change anything without your OK.`):`It reads ${currentTree()?'your current files':'the committed code'} of this project, and only reads. In chat it can’t run commands, open the running app, change files or permissions. Anything it runs or changes, you approve separately, in a handoff or its setup.`,readOnly:true,request:{}});}
// How much it asks (Pips API 58): its level, the chosen level's one line, and what its level did by itself.
const levelState={pip:'',value:null,error:'',busy:false,seq:0};
// A Project Pip has one too from Pips API 80 (pips-11): its lines are about the handoffs it is sent.
const levelShown=()=>S.apiVersion>=58&&!remoteHost&&(personalPip()||S.apiVersion>=80&&!!S.pip);
async function loadLevel(){
 if(!levelShown()||!usable()||levelState.busy)return;   // a change being saved answers for itself
 const token=scope(),pip=S.selected,sequence=++levelState.seq;
 try{const value=levelPage(await send('get_pip_level',{pip_id:pip}),pip);if(token!==scope()||sequence!==levelState.seq||S.selected!==pip)return;
  levelState.pip=pip;levelState.value=value;levelState.error='';syncPay(pip,value);render();}
 catch(error){if(token===scope()&&sequence===levelState.seq){levelState.error=errorText(error);render();}}
}
async function setLevel(level,{refocus=''}={}){
 if(levelState.busy||!usable()||!levelShown())return;const token=scope(),pip=S.selected;levelState.busy=true;levelState.seq++;levelState.error='';render();
 try{const value=levelPage(await send('set_pip_level',{pip_id:pip,level}),pip);if(token!==scope()||S.selected!==pip)return;levelState.pip=pip;levelState.value=value;syncPay(pip,value);S.notice=levelNotice(value);}
 catch(error){if(token===scope())levelState.error=errorText(error);}
 finally{levelState.busy=false;if(token===scope()){render();if(refocus)keepFocus(refocus);}}
}
// Its rule for payments (Pips API 75): Ask (the default) or Let it pay, only at Do it all. Let it pay opens its limits
// under the rule (payFormMarkup): it pays by itself only once a daily limit is set.
async function setPaying(rule){
 if(levelState.busy||!usable()||!levelShown())return;const token=scope(),pip=S.selected;levelState.busy=true;levelState.seq++;levelState.error='';render();
 try{const value=levelPage(await send('set_pip_paying',{pip_id:pip,rule}),pip);if(token!==scope()||S.selected!==pip)return;levelState.pip=pip;levelState.value=value;syncPay(pip,value);
  const name=S.pip?.name||'This Pip';
  S.notice=value.paying==='allow'?payingNotice(name,payState.limits):`${name} asks before every payment again.`;}
 catch(error){if(token===scope())levelState.error=errorText(error);}
 finally{levelState.busy=false;if(token===scope()){render();keepFocus('pipPaying');}}
}
// Focus back on a control a re-render may have drawn anew, unless the user has moved on (typing, another control).
function keepFocus(id){const el=$(id);if(!el)return;const active=el.getRootNode?.().activeElement;if(!active||active===el||!active.isConnected||active===document.body||active.id==='pips-host')el.focus();}
// The chip's menu opens on the chosen level; reading the level again may redraw it, so focus is put back if it was lost.
function focusLevelMenu(){const menu=document.querySelector('.composer-level-menu');if(!menu)return;const active=menu.getRootNode?.().activeElement;if(active&&menu.contains(active))return;(menu.querySelector('[aria-checked="true"]')||menu.querySelector('.dgc-menu-row:not(:disabled)'))?.focus();}
// Where its reports go and the dashboards it refreshes (Pips API 67, artifact_pips): on its page, set on this computer.
// Reports is a reviewing Pip's (a review's findings are what a document or sheet keeps); dashboards are any Pip's. The
// person's dashboards come from the editor's own artifacts list (list_artifact_dashboards), not from a Pip control.
const artifactsState={pip:'',value:null,error:'',busy:false,seq:0,dashboards:null,dashboardsError:''};
const artifactsShown=()=>S.apiVersion>=67&&!remoteHost&&!!S.pip&&!archived();
async function loadArtifacts(){
 if(!artifactsShown()||!usable())return;
 const token=scope(),pip=S.selected,sequence=++artifactsState.seq;
 if(artifactsState.pip!==pip){artifactsState.value=null;artifactsState.dashboards=null;}
 artifactsState.pip=pip;artifactsState.error='';artifactsState.dashboardsError='';
 const [got,list]=await Promise.allSettled([send('get_pip_artifacts',{pip_id:pip}),send('list_artifact_dashboards',{})]);
 if(token!==scope()||sequence!==artifactsState.seq||S.selected!==pip)return;
 try{if(got.status!=='fulfilled')throw got.reason;artifactsState.value=pipArtifacts(got.value);}catch(error){artifactsState.value=null;artifactsState.error=errorText(error);}
 try{if(list.status!=='fulfilled')throw list.reason;artifactsState.dashboards=dashboardList(list.value);}catch(error){artifactsState.dashboards=null;artifactsState.dashboardsError=errorText(error);}
 render();
}
async function setArtifacts(changes,notice){
 if(artifactsState.busy||!usable()||!artifactsShown()||!artifactsState.value)return;const token=scope(),pip=S.selected;artifactsState.busy=true;artifactsState.error='';render();
 try{const value=pipArtifacts(await send('set_pip_artifacts',{pip_id:pip,...changes}));if(token!==scope()||S.selected!==pip)return;artifactsState.pip=pip;artifactsState.value=value;S.notice=typeof notice==='function'?notice(value):notice;}
 catch(error){if(token===scope())artifactsState.error=errorText(error);}
 finally{artifactsState.busy=false;if(token===scope())render();}
}
function dashboardTitle(id){return artifactsState.dashboards?.find(d=>d.id===id)?.title||'that dashboard';}
// A list to save: one that's gone (removed from the person's artifacts) is left out, since the backend refuses a list that
// names one, and nothing can refresh it anyway. Said in the notice. While the person's list didn't load, as it is.
function dashboardsToSave(list){const known=artifactsState.dashboards;return known?list.filter(id=>known.some(d=>d.id===id)):list;}
function goneNote(list){const n=list.length-dashboardsToSave(list).length;return n?` It stopped refreshing ${n===1?'one that’s gone':`${n} that are gone`}.`:'';}
/** On a Personal Pip's page (grouped rows) or in a Pip's Settings tab (sections): `sections`. */
function artifactsSectionMarkup(p,off,sections=false){
 if(!artifactsShown())return '';
 if(artifactsState.pip!==p.id)void loadArtifacts();             // another Pip's, or none yet: this one's
 const mine=artifactsState.pip===p.id;
 return (sections?artifactsSectionsMarkup:artifactsPageMarkup)(mine?artifactsState.value:null,{esc,busy:off||artifactsState.busy,error:mine?artifactsState.error:'',pipName:p.name,reviews:auditPip(p),
  dashboards:mine?artifactsState.dashboards:null,dashboardsError:mine?artifactsState.dashboardsError:''});
}
// From your code (Pips API 64): a Pip your app's code keeps from a template, and the change its template asks for.
const templateState={pip:'',value:null,error:'',busy:false,seq:0};
const templateShown=()=>S.apiVersion>=64&&!remoteHost&&personalPip();
async function loadTemplate(){
 if(!templateShown()||!usable())return;
 const token=scope(),pip=S.selected,sequence=++templateState.seq;
 try{const value=templatePage(await send('list_pip_templates',{pip_id:pip}),pip);if(token!==scope()||sequence!==templateState.seq||S.selected!==pip)return;
  templateState.pip=pip;templateState.value=value;templateState.error='';render();}
 catch(error){if(token===scope()&&sequence===templateState.seq){templateState.pip=pip;templateState.value=null;templateState.error=errorText(error);render();}}
}
async function decideTemplateChange(id,digest,decision){
 if(templateState.busy||!usable()||!templateShown())return;const token=scope(),pip=S.selected;templateState.busy=true;templateState.error='';render();
 try{const result=await send('decide_pip_template_change',{change_id:id,decision,expected_digest:digest});if(token!==scope()||S.selected!==pip)return;
  if(!record(result)||!record(result.change)||result.change.id!==id)throw Error('DGC answered about another change. Refresh.');
  S.notice=typeof result.notice==='string'?result.notice.slice(0,600):'';grantsState.pip='';
  await loadSelected();void loadRoutines();void loadLevel();void loadTemplate();}
 catch(error){if(token===scope())templateState.error=errorText(error);}
 finally{templateState.busy=false;if(token===scope())render();}
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
 root.innerHTML=`<div class="overlay dgc-scrim"><section class="dialog login-dialog dgc-dialog" role="dialog" aria-modal="true" aria-labelledby="review-title"><h2 id="review-title" tabindex="-1">${esc(r.title)}</h2><p>${esc(r.description)}</p>${loginFormMarkup({esc,site:a?a.site:'',shown:a?a.shown:'',fixed:!!a,pipName:S.pip?.name||'It',busy:S.busy})}</section></div>`;
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
 if(remoteHost||S.apiVersion<44||!(personalPip()&&S.pip?.computer_plan||folderBox())||!usable())return;
 const token=scope(),pip=S.selected,sequence=++carefulState.seq;
 try{const value=carefulPage(await send('list_pip_sites',{pip_id:pip}),pip);if(token!==scope()||sequence!==carefulState.seq||S.selected!==pip)return;
  carefulState.pip=pip;carefulState.value=value;carefulState.error='';render();}
 catch(error){if(token===scope()&&sequence===carefulState.seq){carefulState.error=errorText(error);render();}}
}
async function carefulCall(type,fields,notice){
 if(carefulState.busy||!usable()||!(personalPip()||folderBox()))return;const token=scope(),pip=S.selected;carefulState.busy=true;carefulState.error='';render();
 try{const value=carefulPage(await send(type,{pip_id:pip,...fields}),pip);if(token!==scope()||S.selected!==pip)return;carefulState.pip=pip;carefulState.value=value;S.notice=notice;}
 catch(error){if(token===scope())carefulState.error=errorText(error);}
 finally{carefulState.busy=false;if(token===scope())render();}
}
async function navigateAttention(value){
 const {attention:_a,setup,card,cardKind,computer,...rest}=value;
 // Personal Pips live in the Personal workspace; open it first when another is showing.
 if(typeof value.workspace==='string'&&value.workspace!==S.workspace?.id){
  // (With the Project Folder dropdown a card may be a Project Pip's, of any folder: its own project opens.)
  const target=S.workspaces.find(w=>w.id===value.workspace&&(w.kind==='personal'||foldersOn()||onePips()));
  if(!target)throw Error('Your Personal Pips are unavailable here. Refresh the dashboard.');
  await enterWorkspace(target);
 }
 // The Sessions home's "N more need you · Show all": this home at Needs attention, open in full, your Pips under it.
 if(value.all===true){
  if(S.pipSearch){S.pipSearch='';draft.pipSearch='';jobsExtra=[];S.jobsNext=null;}
  clearSelection();S.selected='';S.create=false;S.overview=true;attentionExpanded=2;rememberView();await refresh(false);await loadAttention();render();
  (document.querySelector('.attention')||document.querySelector('.simple-home'))?.scrollIntoView?.({block:'start'});return;
 }
 if(typeof setup==='string'){
  // A new Pip waiting: Needs attention at its card, opened if it is folded, and the keyboard on Review.
  clearSelection();S.selected='';S.create=false;S.overview=true;rememberView();render();await loadSetups();await loadAttention();
  const at=()=>[...document.querySelectorAll('[data-setup-card]')].find(e=>e.dataset.setupCard===setup);
  attentionExpanded=attentionExpanded||1;attentionUserFolded=false;attentionFolded.clear();attentionPlace().key='setup:'+setup;render();
  const el=at()||document.querySelector('.attention');el?.scrollIntoView?.({block:'start'});
  if(el?.dataset.setupCard){cardFlash.selector=`[data-setup-card="${setup}"]`;cardFlash.until=Date.now()+2400;el.classList.add('attention-flash');el.querySelector('button:not([disabled])')?.focus?.({preventScroll:true});}
  return;
 }
 await navigateFromHost({...rest,section:rest.section||'chat'});
 if(S.selected!==value.pip)return;
 if(computer){openComputerView();return;}
 if(value.reviewKind==='app_action'&&typeof value.review==='string'){await openMessageReview(value.review);return;}
 // What only you can do is under the line at the top of its chat: it is opened first.
 if(cardKind==='waiting'&&!flow.waitingOpen){flow.waitingOpen=true;await loadFlow();render();}
 if(typeof card==='string')await revealCard(cardSelector(cardKind,card,s=>CSS.escape(s)));
}
// The chat draws its cards as they load (drafts, plugins, apps): look for a few seconds, then show it.
const cardFlash={selector:'',until:0};
// Only the transcript should scroll when a card or run is opened. scrollIntoView can move the
// entire embedded webview upward and leave the composer stranded in the middle of the editor.
function revealInChat(el,block='center'){
 const log=el.closest('.conversation-log');
 if(!log){el.scrollIntoView?.({block});return;}
 const target=el.getBoundingClientRect(),viewport=log.getBoundingClientRect();
 if(block==='nearest'){
  if(target.top<viewport.top)log.scrollTop+=target.top-viewport.top;
  else if(target.bottom>viewport.bottom)log.scrollTop+=target.bottom-viewport.bottom;
  chatFollow.reading();
  return;
 }
 log.scrollTop+=target.top-viewport.top-(viewport.height-Math.min(target.height,viewport.height))/2;
 chatFollow.reading();
}
async function revealCard(selector){
 const token=scope(),pip=S.selected;
 for(let i=0;i<30;i++){
  const el=document.querySelector(selector);
  if(el){revealInChat(el);cardFlash.selector=selector;cardFlash.until=Date.now()+2400;el.classList.add('attention-flash');(el.querySelector('input[data-code-field]:not([disabled]):not([readonly])')||el.querySelector('button:not([disabled])')||el).focus?.({preventScroll:true});return true;}
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
 pipSearchTimer=window.setTimeout(()=>{const query=' '.concat(value).trim().replace(/\s+/g,' ').slice(0,120);if(query===S.pipSearch)return;S.pipSearch=query;jobsExtra=[];S.jobsNext=null;if(onePips()){one.held=null;one.drawn=null;void loadOne();return;}void refresh(false);},250);
}
function flowMarkup(){
 if(S.apiVersion<72||remoteHost||!S.workspace)return '';
 const ready=flowState.workspace===S.workspace.id&&flowState.loaded;
 const project=projectHome(),choices=S.jobs.filter(p=>p.status==='active'&&(!project||['scout','lens','rook','lock'].includes(p.pip_type)&&p.source_policy?.mode==='committed_only'));
 const form=flowState.form?`<form id="pip-flow-form" class="pip-flow-form"><label>Name<input id="flow-name" maxlength="120" value="${esc(flowDraft.name)}" placeholder="${project?'Review → security check':'Research → writing → image'}"></label><label>Route results<select id="flow-mode"><option value="reviewed"${flowDraft.mode==='reviewed'?' selected':''}>Review each handoff</option><option value="unattended"${flowDraft.mode==='unattended'?' selected':''}>Route without asking again</option></select></label><label>Number of Pips<select id="flow-count">${[2,3,4].map(n=>`<option value="${n}"${flowDraft.count===n?' selected':''}>${n}</option>`).join('')}</select></label><div class="pip-flow-stages">${Array.from({length:flowDraft.count},(_,i)=>`<div class="pip-flow-stage"><label>Step ${i+1} · Pip<select id="flow-pip-${i}"><option value="">Choose Pip</option>${choices.map(p=>`<option value="${esc(p.id)}"${flowDraft.pips[i]===p.id?' selected':''}>${esc(p.name)}</option>`).join('')}</select></label>${i?`<label>Task for this Pip<textarea id="flow-task-${i-1}" maxlength="4000" rows="2" placeholder="What should it do with the previous Pip’s ${project?'top source finding':'result'}?">${esc(flowDraft.tasks[i-1])}</textarea></label>`:`<p class="muted">${project?'A completed source checked run with a finding starts here.':'A manual task or routine run by this Pip starts the workflow.'}</p>`}</div>`).join('')}</div><p class="muted">At most 3 starts in any 24 hours. ${project?'Only the first source checked finding moves to the next read-only Pip, on the same committed source. Patch and Pulse still need their own exact review.':'An unattended route shares the previous Pip’s exact result with the next Pip. It never changes either Pip’s Ask setting or approves mail, publishing, purchases, or computer actions.'} Pause stops future handoffs; queued runs may still finish.</p><div class="actions"><button type="button" id="flow-cancel" class="quiet">Cancel</button><button type="submit" class="primary"${choices.length<2?' disabled':''}>Review workflow…</button></div></form>`:'';
 const rows=ready?flowState.flows.filter(f=>f.status!=='retired').map(f=>{
   const step=f.steps?.[0],pending=step?.status==='review'&&step.handoff_status==='pending';
   const latest=pending?'Latest result is waiting for your handoff review.':step?.status==='paused'?`Latest result stopped here: ${step.reason||'Start a fresh run after checking this step.'}`:step?.handoff_status==='accepted'?'Latest result was handed to the next Pip.':step?.status==='queued'?'Latest result was queued for the next Pip.':'';
   return `<div class="pip-flow-row"><div><strong>${esc(f.name)}</strong><small>${esc(f.definition.pips.map(pin=>S.jobs.find(p=>p.id===pin.pip_id)?.name||'Pip').join(' → '))} · ${f.mode==='reviewed'?'Review each handoff':'Unattended handoffs'} · ${f.status==='on'?'On':'Paused'}</small>${latest?`<small class="pip-flow-latest">${esc(latest)}</small>`:''}</div><div class="pip-flow-actions">${pending?`<button type="button" data-flow-handoff="${esc(f.id)}">Review</button>`:''}<button type="button" data-flow-status="${esc(f.id)}" data-flow-revision="${f.revision}" data-flow-next="${f.status==='on'?'paused':'on'}"${S.busy?' disabled':''}>${f.status==='on'?'Pause':'Resume'}</button><button type="button" data-flow-status="${esc(f.id)}" data-flow-revision="${f.revision}" data-flow-next="retired"${S.busy?' disabled':''}>Remove</button></div></div>`;
 }).join(''):'';
 const suggestions=ready&&!project&&!flowState.form?flowState.suggestions.filter(s=>s.pips.every(p=>S.jobs.some(job=>job.id===p.pip_id&&job.status==='active'))).map(s=>`<div class="pip-flow-row"><div><strong>Core’s suggested team</strong><small>${esc(s.pips.map(p=>p.name).join(' → '))} · Add the handoff tasks and review its mode</small></div><div class="pip-flow-actions"><button type="button" data-core-flow="${esc(s.id)}">Set up workflow</button></div></div>`).join(''):'';
 return `<section class="pip-flows" aria-label="Pip workflows"><div class="pip-flow-head"><div><h2>Workflows</h2><p class="muted">${project?'Pass a source finding to the next read-only Pip.':'Pass one Pip’s result to the next.'}</p></div>${!flowState.form?`<button type="button" id="flow-new" class="quiet pill"${S.busy?' disabled':''}>New workflow</button>`:''}</div>${flowState.loading?'<p class="muted">Loading workflows…</p>':''}${flowState.error?`<p class="notice">${esc(flowState.error)}</p>`:''}${suggestions}${rows||(!suggestions&&!flowState.form&&!flowState.loading?'<p class="muted">No workflows yet.</p>':'')}${form}</section>`;
}
async function loadFlows(){
 if(S.apiVersion<72||remoteHost||!S.workspace||flowState.loading)return;
 const workspace=S.workspace.id,token=scope();flowState.loading=true;flowState.error='';
 if(flowState.workspace&&flowState.workspace!==workspace){flowState.form=false;flowDraft.pips=['','','',''];flowDraft.tasks=['','',''];flowDraft.name='';}
 try{const answer=await send('list_pip_flows',{workspace_id:workspace});if(token!==scope()||S.workspace?.id!==workspace)return;if(!Array.isArray(answer.flows)||!answer.flows.every(f=>f.workspace_id===workspace)||!Array.isArray(answer.core_suggestions)||!answer.core_suggestions.every(s=>typeof s.id==='string'&&Array.isArray(s.pips)&&s.pips.length>=2&&s.pips.length<=3&&s.pips.every(p=>typeof p.pip_id==='string'&&typeof p.name==='string')))throw Error('Workflow list does not match this workspace.');flowState.workspace=workspace;flowState.flows=answer.flows;flowState.suggestions=answer.core_suggestions;flowState.loaded=true;flowState.loadedAt=Date.now();}
 catch(error){if(token===scope())flowState.error=errorText(error);}
 finally{
  flowState.loading=false;
  if(token===scope()&&(!S.selected||S.overview)&&!S.create){
   render();
   // The user may switch Personal/Project while the previous workspace is loading.
   // Start the new workspace's read once the old promise releases its loading slot.
   if(S.workspace?.id!==workspace&&S.workspace?.id!==flowState.workspace)void loadFlows();
  }
 }
}
function reviewFlow(){
 const name=flowDraft.name.trim(),pip_ids=flowDraft.pips.slice(0,flowDraft.count),tasks=flowDraft.tasks.slice(0,flowDraft.count-1).map(v=>v.trim());
 if(!name||new TextEncoder().encode(name).length>120||pip_ids.some(id=>!S.jobs.some(p=>p.id===id&&p.status==='active'))||new Set(pip_ids).size!==pip_ids.length||tasks.some(t=>!t||new TextEncoder().encode(t).length>4000)){flowState.error='Name the workflow, choose distinct active Pips, and write each handoff task.';render();return;}
 const mode=flowDraft.mode;
 if(!['reviewed','unattended'].includes(mode))return;
 const steps=pip_ids.map((id,i)=>`<li><strong>${esc(S.jobs.find(p=>p.id===id)?.name||'Pip')}</strong>${i?`<p>${esc(tasks[i-1])}</p>`:'<p>Manual task or routine starts here.</p>'}</li>`).join('');
 const body=`<ol class="pip-flow-review">${steps}</ol><p><strong>${mode==='reviewed'?'Review each handoff':'Unattended handoffs'}</strong> · Up to 3 starts in any 24 hours.</p><p class="muted">${projectHome()?'Only the top source checked finding reaches the next read-only Pip. File fixes and test commands still require their own exact review.':'Unattended only routes the exact prior result. Each Pip’s Ask setting and all action approvals stay in force.'} Pause stops future handoffs, but already queued runs may finish.</p>`;
 openReview({title:name,description:'Review this exact Pip sequence and its routing mode.',body,confirm:'Create workflow',request:{type:'create_pip_flow',name,pip_ids,tasks,mode}});
}
function simpleHomeMarkup(){
 const all=S.jobs.filter(p=>S.showArchived||p.status!=='archived'),live=S.jobs.filter(p=>p.status!=='archived');
 // (A project's home too, while its Pips are being read: its empty home, with New Pip, flashed before the list.)
 // (The Project Folder dropdown's line is there while they are read and while a search hides Needs attention.)
 if(projectHome())return !S.jobsRead&&!S.error&&!S.jobs.length&&!S.pipSearch?folderLineMarkup()+loadingMark():folderLineMarkup()+(S.pipSearch?'':attentionHomeMarkup())+simpleHomeList(all,live)+(S.pipSearch?'':flowMarkup());
 // Only once the list has come back empty: while it's being read a Pip's owner saw Meet Core's large face, and could press Create Core.
 if(!live.length&&!S.jobs.length&&!S.pipSearch)return S.jobsRead?attentionHomeMarkup()+meetCoreMarkup():loadingMark();   // a search that finds nothing is not an empty home
 return (S.pipSearch?'':attentionHomeMarkup())+simpleHomeList(all,live)+(S.pipSearch?'':flowMarkup());
}
// A project's home: where the Personal home has Pips settings, a menu with the project's own pages (its context and its
// notifications: the old side bar's buttons), and with no Pips yet, what each character does.
function projectHomeMenu(){
 return `<details class="pip-menu" data-details="home-menu"><summary class="topbar-icon" aria-label="Project pages" title="Project pages: its context and notifications">${simpleIcon('more')}</summary><div class="tabs-menu dgc-menu dgc-menu-rows">${button('workspace-context','Workspace context',!usable())}${S.apiVersion>=13?button('workspace-notifications','Notifications',!usable()):''}</div></details>`;
}
function projectFirstMarkup(){
 return `<div class="project-first"><div class="pips-welcome-cast">${['scout','rook','pulse'].map(id=>avatar('idle',characterType(id),`welcome-${id}`)).join('')}</div><h3>What should your first Pip look after?</h3><p class="muted">Pick a character for the job: Scout, Lens, Rook and Lock read the code, Patch fixes it, Pulse runs its checks and Quill writes its docs. You approve anything that changes files or runs commands.</p>${button('create-first','New Pip',S.busy||!usable()||!S.types.length,'primary pill')}</div>`;
}
// One row of a list of Pips: its face, its name, where it works (`place`, the one list's: "Personal" or its folder) and
// its status; what waits on it as a number, something new to read as a dot.
function homeRow(p,place=''){const type=pipType(p,S.types)||characterType(p.pip_type),pose=presentation(p,[],usable(),S.runner),waiting=waitingOn(S.attention,p.id,pendingReviews(p)),unread=p.status==='archived'||readingPips.has(p.id)?null:unreadByPip.get(p.id),readable=!!unread&&canMarkRead(unread);
  // A number is what waits on it, and it's the row's own (a click on it opens the row). A dot is something new to read, and
  // over the row's end when it can be read from here, so the row keeps its room for it.
  const count=waiting?`<span class="pip-row-count" aria-hidden="true">${waiting}</span>`:'',latest=unread?`<span class="pip-row-latest">${esc(unread.latest)}</span>`:'';
  const both=count&&unread?' pip-row-both':'';
  const marks=readable?`<span class="pip-row-marks pip-row-room${both}" aria-hidden="true"><span class="pip-row-read-slot"></span>${count}</span>`
   :unread?`<span class="pip-row-marks${both}"><span class="pip-row-read-slot" role="img" aria-label="${unread.count} new"><span class="pip-new-dot"></span></span>${count}</span>`
   :count?`<span class="pip-row-marks">${count}</span>`:'';
  const button=`<button type="button" class="pip-row${marks?' pip-row-marked':''}" data-job="${esc(p.id)}" data-state="${esc(pose.state)}" data-waiting="${waiting}" title="${esc(p.name)}">${pipAvatar(p,pose.state,`row-${p.id}`,type)}<span class="pip-row-copy"><strong><span class="pip-row-name">${esc(p.name)}</span>${p.pip_type==='core'?'<span class="primary-badge" title="Your Primary Pip. It uses Core, the character of DGC’s main chat." aria-label="Primary Pip">★</span>':''}</strong><small>${place}${S.pipSearch&&record(p.match)&&['chat','instructions'].includes(p.match.in)&&typeof p.match.text==='string'?`<span class="pip-match">${p.match.in==='chat'?'In its chat':'In its instructions'}: ${esc(p.match.text.slice(0,200))}</span>`:p.status==='archived'?'Archived':pipOff(p)?`Off${waiting?` · ${waiting} waiting for you`:''}${unread?' · '+latest:''}`:p.routine_health?.blocked?healthMarkup(p.routine_health,{row:true})+(waiting?` · ${waiting} waiting for you`:''):waiting?`${waiting} waiting for you${unread?' · '+latest:''}`:unread?latest:p.routine_health&&pose.state!=='working'?healthMarkup(p.routine_health,{row:true}):esc(pose.label)}</small></span>${marks}</button>`;
  // Its dot is its own button over the row's end (never inside the row): "Read" on hover or focus, and a click
  // marks its whole chat read without opening it.
  if(!readable)return button;
  const label=`Mark ${p.name}'s ${unread.count} new message${unread.count===1?'':'s'} as read`,dot=pose.state==='working'||pose.state==='waiting_approval'&&!waiting;
  return `<div class="pip-row-item${dot?' pip-row-dot':''}">${button}<span class="pip-row-marks pip-row-marks-live${count?' pip-row-both':''}"><button type="button" class="pip-row-read" id="pip-read-${esc(p.id)}" data-pip-read="${esc(p.id)}" aria-label="${esc(label)}" title="Mark as read, without opening its chat"><span class="pip-new-dot" aria-hidden="true"></span><span class="pip-read-word">Read</span></button>${count}</span></div>`;}
function homeRowInner(p,place=''){const pin=jobPin(p),row=homeRow(p,place);return pin?`<div class="pip-row-slot${dockPins.has(`pip:${p.id}`)?' is-pinned':''}">${row}${pin}</div>`:row;}
// Its on/off switch is beside the row, at the right end (never inside it: the row is a button). Off, the row reads black and white.
function homeRowSlot(p,place=''){const toggle=pipSwitchMarkup(p);return toggle?`<div class="pip-row-line${pipOff(p)?' is-off':''}" data-pip-line="${esc(p.id)}">${homeRowInner(p,place)}${toggle}</div>`:homeRowInner(p,place);}
function simpleHomeList(all,live){
 const order=[...all.filter(p=>p.pip_type==='core'),...all.filter(p=>p.pip_type!=='core')];
 const project=projectHome();
 // One heading on the Project tab (seen live, 12 Nov night: one folder's list said "Your Pips", All projects' "Project
 // Pips"); the Personal tab keeps its own, and so does a view with no tabs.
 const heading=project&&scopeTabs()?'Project Pips':'Your Pips';
 // Folders (pips-12): Pips with no folder first, under no heading; then each folder under its heading, which folds it.
 // A search is one list of what matched. The Project list has no folders.
 const slot=p=>homeRowSlot(p);
 // Its on/off switch is beside the row, at the right end (never inside it: the row is a button). Off, the row reads black and white.
 const held=foldersListed()&&!S.pipSearch?pipsByFolder(order):null;
 const listed=held?.folders.length?`${held.loose.length?`<div class="pip-rows">${held.loose.map(slot).join('')}</div>`:''}<div class="pip-folders">${held.folders.map((f,i)=>folderMarkup(f,i,{esc,open:!foldersClosed.has(f.name),rows:f.pips.map(slot).join('')})).join('')}</div>`
  :`<div class="pip-rows">${order.map(slot).join('')}</div>`;
 return `<section class="simple-home" aria-label="${heading}"><div class="simple-home-head"><h2>${heading}</h2><span class="simple-home-actions">${project?projectHomeMenu():S.apiVersion>=43&&!remoteHost?`<button type="button" id="pips-settings-open" class="topbar-icon" aria-label="Pips settings" title="Pips settings: computers, apps and plugins"${!usable()?' disabled':''}>${simpleIcon('gear')}</button>`:''}${project?'':teamMenuMarkup()}${button('simple-new','New Pip',S.busy||!usable(),'primary pill')}</span></div>${pipsPaged()?`<div class="pip-search"><label class="sr-only" for="pip-search">Search your Pips</label><input id="pip-search" type="search" placeholder="Search your Pips" autocomplete="off" value="${esc(draft.pipSearch||'')}" maxlength="120">${S.jobsTotal!==null&&(S.jobsTotal>S.jobs.length||S.pipSearch)?`<small class="pip-search-count">${S.pipSearch?`${S.jobsTotal.toLocaleString('en-US')} found`:`Showing ${S.jobs.length.toLocaleString('en-US')} of ${S.jobsTotal.toLocaleString('en-US')}`}</small>`:''}</div>`:''}${project?(S.jobs.length||S.pipSearch?'':projectFirstMarkup()):live.some(p=>p.pip_type==='core')||S.pipSearch?'':`<div class="core-offer">${avatar('idle',characterType('core'),'core-offer')}<p><strong>Meet Core</strong><span>Your Primary Pip, for everyday tasks.</span></p>${button('create-core','Create',S.busy||!usable(),'primary pill')}</div>`}${listed}${S.pipSearch&&!S.jobs.length?`<p class="muted">No Pip matches “${esc(S.pipSearch)}” in its name, instructions or chat.</p>`:''}${pipsPaged()&&S.jobsNext!==null?button('pips-more',jobsMoreBusy?'Loading…':'Load more',jobsMoreBusy||!usable(),'link'):''}${S.jobs.some(p=>p.status==='archived')?button('show-archived',S.showArchived?'Hide archived':'Show archived',false,'link'):''}</section>`;
}
// A Personal Pip's character is only its face and its name (its job is what you tell it): its big face, and a list of
// the names, each with its small face.
function newPipBody(){
 const chooser=pickerMarkup({id:'new-pip-character',label:'Character',value:draft.newPipCharacter,face:avatar('idle',characterType(draft.newPipCharacter),'new-face'),
  options:SIMPLE_CHARACTERS.filter(id=>id!=='core').map(id=>{const t=characterType(id);return {value:id,label:t.name,face:avatar('idle',t,`new-${id}`)};})});
 return `${chooser}<label for="newPipName">Name<input id="newPipName" data-draft="newPipName" maxlength="60" autocomplete="off" placeholder="Like Gmail, Travel or Money" value="${esc(draft.newPipName)}"></label><p class="muted">It says hello and sets itself up in its chat. No job form.</p>`;
}
// One New Pip (his "perfect", 13 Nov): a character, a name, and one folder line pre-filled from where you are: the
// filter's folder, or the folder it was asked for from (a Work session's), else "+ Give it a folder", which is a Pip
// with no folder (Personal). One click changes it; it is decided here, at creation. No goal, no branch and no model:
// it sets itself up in its own chat. Describing the job to DGC and a shared Pip's file are one click away.
function oneNewPipFolderField(){
 const Pick=globalThis.DgcFolderPick;if(!Pick)return '';
 const rows=createFolderRows(),row=rows.find(r=>r.folder===draft.createFolder);
 return `<div class="new-pip-folder new-pip-folder-one">${Pick.buttonHtml({id:'new-pip-folder',rows,choice:row?row.folder:'',label:'Folder',empty:'+ Give it a folder',title:row?`It works in ${row.folder}`:'It works in no folder (Personal). Give it one to work on that folder’s files.'})}${row?`<p class="new-pip-folder-path" title="${esc(row.folder)}">${Pick.pathHtml(row.shown,row.folder)}</p>`:'<p class="muted new-pip-folder-none">No folder: it is a Personal Pip.</p>'}</div>`;
}
function oneNewPipBody(){
 const chooser=pickerMarkup({id:'new-pip-character',label:'Character',value:draft.newPipCharacter,face:avatar('idle',characterType(draft.newPipCharacter),'new-face'),
  options:SIMPLE_CHARACTERS.filter(id=>id!=='core').map(id=>{const t=characterType(id);return {value:id,label:t.name,face:avatar('idle',t,`new-${id}`)};})});
 const row=createFolderRows().find(r=>r.folder===draft.createFolder);
 // (Both make a card to review in that folder's project: offered once a folder is chosen.)
 const other=row?`<p class="new-pip-other">${button('new-pip-describe','Describe the job to DGC instead',S.busy,'link')}${button('import-pip-file','Import a shared Pip…',S.busy||!usable(),'link')}</p>`:'';
 return `${chooser}<label for="newPipName">Name<input id="newPipName" data-draft="newPipName" maxlength="60" autocomplete="off" placeholder="Like Gmail, Travel or Money" value="${esc(draft.newPipName)}"></label>${oneNewPipFolderField()}<p class="muted">It says hello and sets itself up in its chat. No job form.</p>${other}`;
}
function oneNewPipReview(){return {title:'New Pip',description:'Pick a character and give it a name.',body:oneNewPipBody(),confirm:'Create',newPip:true,onePip:true,request:{type:'create_pip'}};}
function openOneNewPip(asked=''){
 draft.newPipName='';draft.newPipCharacter=draft.newPipCharacter||'scout';
 draft.createFolder=newPipFolder(one.filter,createFolderRows(),asked||one.asked);one.asked='';
 openReview(oneNewPipReview());$('newPipName')?.focus();
}
// The project of the form's folder: DGC's own for it, made one first when the folder is not a project yet.
async function oneFolderSpace(row){
 if(row.workspace_id)return row.workspace_id;
 const added=await send('add_project_folder',{folder:row.folder}),space=added?.workspace;
 if(!record(space)||typeof space.id!=='string'||!/^ws_[a-f0-9]{32}$/.test(space.id))throw Error('DGC didn’t say which project that folder is. Try again.');
 if(!S.workspaces.some(w=>w?.id===space.id))S.workspaces=[...S.workspaces,space];
 row.workspace_id=space.id;return space.id;
}
async function createOnePip(review){
 const name=(draft.newPipName||'').trim();
 if(!name){review.error='Give it a name.';renderReview();$('newPipName')?.focus();return;}
 if(S.busy||!usable())return;
 let workspace=personalSpace()?.id||'';
 if(draft.createFolder){
  const row=createFolderRows().find(r=>r.folder===draft.createFolder);
  if(!row||!row.exists){review.error='That folder isn’t there any more. Choose another, or none.';renderReview();return;}
  S.busy=true;review.error='';renderReview();
  try{workspace=await oneFolderSpace(row);}catch(error){S.busy=false;if(S.review===review){review.error=errorText(error);renderReview();}else setError(error);return;}
  S.busy=false;if(S.review!==review)return;
 }
 await createSimplePip(draft.newPipCharacter,name,review,workspace);
}
// Describe the job to DGC, or a shared Pip's file, from New Pip: both belong to the form's folder, whose project is
// opened underneath first.
async function oneLeaveForFolder(then){
 const row=createFolderRows().find(r=>r.folder===draft.createFolder);if(!row||!usable()||S.busy)return;
 closeReview();
 try{const id=await oneFolderSpace(row),space=S.workspaces.find(w=>w?.id===id);if(!space)throw Error('That folder’s project isn’t on this computer any more.');
  if(S.workspace?.id!==id)await enterWorkspace(space);if(S.workspace?.id===id)then();}
 catch(error){setError(error);}
}
function openNewPip(asked=''){
 if(S.busy||!usable())return;
 if(onePips()){openOneNewPip(typeof asked==='string'?asked:'');return;}
 if(projectHome()){openNewProjectPip();return;}
 draft.newPipName='';draft.newPipCharacter=draft.newPipCharacter||'scout';
 openReview({title:'New Pip',description:'Pick a character and give it a name.',body:newPipBody(),confirm:'Create',newPip:true,request:{type:'create_pip'}});
 $('newPipName')?.focus();
}
// A new Project Pip (reported 24 Oct): the Personal flow's character picker, where the character is the kind of work
// it does, so its list is of jobs ("Review the code for bugs", Rook beside it), then what the old form asked: its name,
// what it does, the branch or commit it reads, and its model. It sends the old form's create_pip, so it makes the same
// Pip; Patch and Pulse still show what they can do before they are made. Describing the job to DGC, a common job and a
// shared Pip's file are one click away, under the form.
// The list says what each does in plain words, from the catalog's descriptions (dgc/pip_types.py), with the character's
// name beside it: you pick the job and the face follows.
const PROJECT_JOBS={scout:'Map out the project',lens:'Answer a question about the code',patch:'Fix files you approve',rook:'Review the code for bugs',pulse:'Run tests you approve',lock:'Look for security problems',quill:'Draft documentation'};
function pickProjectKind(id){
 const type=S.types.find(t=>t.id===id&&t.id!=='core');if(!type?.available)return false;
 if(S.createType!==id){rememberCreationDraft();S.createType=id;Object.assign(draft,creationDrafts.get(id)||{name:type.default_name,goal:type.default_goal,source_ref:'HEAD',createModel:'default'});}
 return true;
}
// The project's own pages, from its home's menu on the simple page: no Pip is open under them.
function leaveForProjectPage(){if(!simpleMode()||!projectHome()||!S.selected)return;chatDrafts.set(S.selected,draft.chatText);clearSelection();S.selected='';}
function newProjectPipModel(){return modelPicker('createModel','Model',draft.createModel,false);}
function newProjectPipBody(){
 const type=S.types.find(t=>t.id===S.createType&&t.available);
 const kinds=SIMPLE_CHARACTERS.filter(id=>id!=='core').map(id=>S.types.find(x=>x.id===id)).filter(Boolean);
 const chooser=pickerMarkup({id:'new-pip-kind',label:'What should it do?',value:type?.id||'',placeholder:'Choose what it should do',face:avatar('idle',type||null,'new-face'),
  options:kinds.map(t=>({value:t.id,label:PROJECT_JOBS[t.id]||t.role||t.name,aside:t.name,disabled:!t.available,reason:t.available?'':t.unavailable_reason||'Not available yet',face:avatar(t.available?'idle':'offline',t,`new-${t.id}`)}))});
 const other=`<p class="new-pip-other">${S.apiVersion>=23?button('new-pip-describe','Describe the job to DGC instead',S.busy,'link'):''}${S.apiVersion>=41&&!remoteHost?button('import-pip-file','Import a shared Pip…',S.busy||!usable(),'link'):''}</p>`;
 // The folder it works in (the Project Folder dropdown, Pips API 93): this window's folder first.
 const where=foldersOn()?createFolderRows().find(r=>r.folder===draft.createFolder)?.name||'the folder you choose':S.workspace?.name||'this project';
 if(!type)return `${chooser}${newPipFolderField()}<p class="muted">Pick what it should do.</p>${other}`;
 const when=pulsePip(type)?'It can’t run any commands yet. After you create it, you can give it a command plan and a schedule.':executionPip(type)?'It runs only on a handoff you approve, never on a schedule.':documentationPip(type)?(S.apiVersion>=20?'After you create it, you can give it a schedule or have it run on events. It doesn’t take handoffs.':'Update DGC to give Quill a schedule or run it on events. It doesn’t take handoffs.'):'After you create it, you can give it a schedule.';
 const reads=executionPip(type)?'Chatting with it never changes files. You approve every fix or test run separately; creating it allows neither.':documentationPip(type)?'Quill writes drafts with the model and quotes the exact code it used. It never changes or publishes your files.':'All of these read the code the same way; the character you pick doesn’t give it more access.';
 return `${chooser}<div class="new-pip-kind"><p class="type-role"><strong>${esc(type.name)}</strong> · ${esc(type.role)} · ${executionPip(type)?'You approve each run':documentationPip(type)?'Private drafts':'Reads only'}</p><p class="muted">${esc(type.description)}</p><p class="muted">It runs when you ask, in ${esc(where)}. ${esc(when)}</p></div>${newPipFolderField()}<div class="form new-pip-form">${field('name','Name')}${field('goal','What it does',true)}${field('source_ref','Branch or commit')}<p class="muted">It reads only committed code from the branch or commit you choose: HEAD, a branch name or a commit. Uncommitted edits aren’t included. ${esc(reads)}</p><div id="new-pip-model">${newProjectPipModel()}</div></div>${other}`;
}
function newProjectPipReview(){
 const type=S.types.find(t=>t.id===S.createType&&t.available);
 return {title:'New Pip',description:'Pick what it should do, then name it.',body:newProjectPipBody(),confirm:type&&executionPip(type)?'Review what it can do…':'Create Pip',newPip:true,projectPip:true,request:{type:'create_pip'}};
}
function openNewProjectPip(){
 if(S.busy||!usable())return;
 setupEditing=false;
 // Its folder: the one chosen in the Project tab's dropdown, where it still exists (seen live, 12 Nov night: with
 // another folder chosen the form opened on this window's); on All projects, or for a folder that is gone, this
 // window's; with none open, the folder whose list this is.
 if(foldersOn()){const rows=createFolderRows(),chosen=chosenFolder();draft.createFolder=(chosen&&rows.find(r=>r.folder===chosen.folder&&r.exists)||rows.find(r=>r.here&&r.exists)||rows.find(r=>r.workspace_id===S.workspace?.id&&r.exists)||{}).folder||'';}
 if(!pickProjectKind(S.createType))['scout','rook','lens','lock','quill','pulse','patch'].some(id=>pickProjectKind(id));
 openReview(newProjectPipReview());
 newPipModelKey='';if(!S.modelsLoading)void loadModels();
 $('name')?.focus();
}
// The models arrive after the dialog opens: its picker is redrawn in place when they do (not the fields being typed in).
let newPipModelKey='';
function syncNewPipModel(){
 if(!S.review?.projectPip)return;const box=$('new-pip-model');if(!box)return;
 const key=JSON.stringify([S.models.map(m=>m.id),S.modelsLoading,S.modelsError,S.defaultModel,S.defaultEngine?.name||'']);
 if(key===newPipModelKey)return;newPipModelKey=key;box.innerHTML=newProjectPipModel();
}
// Patch and Pulse say what they can do before they are made (the old form's second step, as it was).
function executionCreateReview(type,request,choice){
 return {title:`Create ${type.name}?`,description:type.id==='pulse'?'You can chat with it, but it can’t run any commands yet. You approve each command it runs, in a handoff or a command plan.':'You can chat with it, but it can’t change files or run tests on its own. You approve each fix in a handoff first.',body:`<h3>${esc(request.name)}</h3><p class="goal">${esc(request.goal)}</p><dl class="meta"><dt>Branch or commit</dt><dd>${esc(request.source_ref)}</dd><dt>Model</dt><dd>${esc(modelLabel(choice))}</dd><dt>Runs</dt><dd>Only when you approve it</dd></dl><p class="muted">${type.id==='patch'?'Patch can change only the exact files you approve, in a private copy.':'Pulse can run only the exact commands you approve, in a private copy.'} No network, and your files are never changed. ${type.id==='pulse'?'After you create it, you can give it a command plan and a schedule.':'It doesn’t run on a schedule.'}</p><p class="muted">${seatbeltRunner()?'Each approved test gets up to 60 seconds, 30 seconds of CPU per process and 64 KB of output. On macOS, the 512 MB memory, 32-process and 64 MB scratch limits are checked every so often, not enforced exactly. Tests can’t change the code.':'Each approved test gets up to 60 seconds, 30 seconds of CPU and 512 MB of memory per process, 64 KB of output and 32 processes, with a 64 MB scratch folder. Total memory is checked every so often, not enforced exactly. Tests can’t change the code.'} You see these limits again with each command.</p>`,confirm:'Create Pip',request};
}
// The old form's request, from the dialog: the same fields, checked the same way.
function createProjectPip(review){
 const type=S.types.find(t=>t.id===S.createType);
 if(!type?.available||type.id==='core'){review.error='Pick a character for the job.';renderReview();return;}
 if(!draft.name.trim()||!draft.goal.trim()||!draft.source_ref.trim()){review.error='Give it a name, say what it does, and choose a branch or commit.';renderReview();return;}
 let choice;try{choice=modelChoice(draft.createModel,S.models,subscriptionChoices(false),routerOffer(),savedProviders());}catch(error){review.error=errorText(error);renderReview();return;}
 const proceed=workspaceId=>{
  const request={type:'create_pip',workspace_id:workspaceId,pip_type:type.id,model_choice:choice,name:draft.name.trim(),goal:draft.goal.trim(),source_ref:draft.source_ref.trim()};
  if(executionPip(type)){openReview({...executionCreateReview(type,request,choice),secondary:{id:'new-pip-back',label:'Back'}});return;}
  void mutate(request,finishCreate);
 };
 if(!foldersOn()){proceed(S.workspace.id);return;}
 // In the folder its form chose: made in that folder's project (added as one first, when it isn't yet), and opened
 // here (finishCreate). DGC's refusal shows in the form.
 const row=createFolderRows().find(r=>r.folder===draft.createFolder);
 if(!row||!row.exists){review.error='Choose the folder this Pip works in.';renderReview();return;}
 if(row.workspace_id){proceed(row.workspace_id);return;}
 if(S.busy)return;
 void (async()=>{
  S.busy=true;review.error='';renderReview();
  try{const added=await send('add_project_folder',{folder:row.folder}),space=added?.workspace;
   if(!record(space)||typeof space.id!=='string'||!/^ws_[a-f0-9]{32}$/.test(space.id))throw Error('DGC didn’t say which project that folder is. Try again.');
   if(!S.workspaces.some(w=>w?.id===space.id))S.workspaces=[...S.workspaces,space];
   row.workspace_id=space.id;
  }catch(error){S.busy=false;if(S.review===review){review.error=errorText(error);renderReview();}else setError(error);return;}
  S.busy=false;
  if(S.review===review)proceed(row.workspace_id);
 })();
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
async function createSimplePip(type,name,review=null,workspaceId=''){
 name=(name||'').trim();
 if(!name){if(review){review.error='Give it a name.';renderReview();$('newPipName')?.focus();}return;}
 if(S.busy||!usable())return;const token=scope();S.busy=true;if(review)renderReview();else render();
 try{
  const space=workspaceId||(onePips()?personalSpace()?.id:'')||S.workspace.id;
  const created=await send('create_pip',{workspace_id:space,pip_type:type,name,goal:'',source_ref:'HEAD',model_choice:{mode:'default'}});
  if(token!==scope())return;const pip=created?.pip;
  if(!record(pip)||typeof pip.id!=='string'||pip.workspace_id!==space)throw Error('The new Pip did not come back as expected. Refresh to see it.');
  // Its hello is a first turn DGC sends; the chat opens while it is being written.
  await ensureRunner();
  let introError='';
  try{const said=await send('introduce_pip',{pip_id:pip.id});if(said?.no_provider===true)S.noProvider=true;}catch(error){introError=`${pip.name} was created, but its first message could not start: ${errorText(error)}`;}
  if(token!==scope())return;if(review)closeReview();S.busy=false;
  // A Pip of another folder than the one loaded underneath opens in its own project.
  if(space!==S.workspace.id){void loadOne();render();await navigateFromHost({pip:pip.id});if(introError){S.error=introError;render();}return;}
  await refresh(true);if(token!==scope())return;await select(pip.id);
  if(introError){S.error=introError;render();}
 }catch(error){if(token===scope()){if(review&&S.review===review){review.error=errorText(error);renderReview();}else setError(error);}}
 finally{if(token===scope()){S.busy=false;render();if(S.review)renderReview();}}
}
// ---- What a Pip found, and what became of it, as cards in its own chat (the Pips flow design, 14 Nov; src/pipFlow.js) ----
// Read with list_pip_fixes (Pips API 96) each time its chat and its runs are read: the fixes of its checks' findings
// (the Allow card, the fix while it runs, its change) and what only you can do. Nothing here decides: Allow, Not now,
// Stop, and the answers to "waiting on you" go to DGC, and what it says back is drawn.
const flow={pip:'',value:null,error:'',seq:0,busy:null,errors:new Map(),menu:'',waitingOpen:false,stopping:'',notes:new Map()};
function resetFlow(){resetAgents();flow.pip='';flow.value=null;flow.error='';flow.seq++;flow.busy=null;flow.errors.clear();flow.menu='';flow.waitingOpen=false;flow.stopping='';flow.notes.clear();}
const flowOn=()=>S.apiVersion>=FLOW_API&&!remoteHost&&onePips()&&!!S.pip&&!archived();
const flowNow=()=>flowOn()&&flow.pip===S.selected?flow.value:null;
// ---- Its chat as a conversation, with its sub-agents (Pips API 97; src/pipChat.js) ----
// From Pips API 97 a fix is a sub-agent's job, and the Pip's chat reads as a conversation: its words as Work's prose
// with its face and name once per run of messages, what a check found as a list in its message, Work's permission
// card, its sub-agent's row, Work's changed-files card, and in the prompt box the sub-agents pill that opens the agent
// map for this Pip. Its sub-agents are read with list_pip_agents each time its fixes are, and every three seconds
// while one works; what one is doing and its steps come from its run's activity (list_pip_run_activity).
const convOn=()=>flowOn()&&S.apiVersion>=CHAT_API;
const AGENT_CHECK=/^This message is from DGC, not the user\. A sub-agent you handed a job to has finished try /;
// The Pip's reply to DGC's "check your sub-agent's work" is not a second message: the fix says its words (`message`),
// without the FINDING and RESULT lines the reply ends with.
function agentCheckReply(m){
 if(!convOn()||m.role!=='assistant')return false;
 const asked=S.messages.find(p=>p.role==='user'&&p.intro===true&&p.run_id===m.run_id);
 return !!asked&&AGENT_CHECK.test(asked.text||'');
}
// Focus the map moves by itself after a click is quiet (no ring); the keyboard's always shows.
let agentsByPointer=false;
const amFocus=el=>{if(!el)return;el.classList.toggle('quiet-focus',agentsByPointer);el.focus({preventScroll:true});};
const agentsUi={pip:'',list:[],slots:1,seq:0,doing:new Map(),steps:new Map(),stepsOpen:new Set(),map:false,card:'',earlier:false,stopping:'',timer:0,drawn:''};
const changeUi={folded:new Set(),menu:''};const askedWords=new Map();
function resetAgents(){window.clearTimeout(agentsUi.timer);Object.assign(agentsUi,{pip:'',list:[],slots:1,seq:agentsUi.seq+1,map:false,card:'',earlier:false,stopping:'',timer:0});agentsUi.doing.clear();agentsUi.steps.clear();agentsUi.stepsOpen.clear();changeUi.folded.clear();changeUi.menu='';renderAgentMap();}
const agentsNow=()=>convOn()&&agentsUi.pip===S.selected?agentsUi.list:[];
const fixAgents=()=>convOn()?(flowNow()?.fixes||[]).map(f=>f.agent).filter(Boolean):[];
const agentOf=id=>agentsNow().find(a=>a.id===id)||fixAgents().find(a=>a.id===id)||null;
// Ultra on the Pip's thinking slider (live round 1, 14 Nov): up to 4 sub-agents at once for this Pip (set_pip_agents,
// Pips API 97: 1 is a Pip's usual, 4 is Ultra). Offered once DGC has said how many this Pip runs.
const ULTRA_SLOTS=4;let ultraBusy=false;
// The Sub-agents tab of a Pip's model menu. What is true today: a Pip's sub-agents run on the Pip's own model, at its
// thinking, one at a time or up to `slots` at once (Ultra is 4). DGC cannot yet give a Pip's sub-agents a model, a
// thinking level, a context window or a fallback of their own (set_pip_agents takes only `slots`), so the tab offers
// none: when it can, their list goes under the row here, with "This Pip's model" first, and each row's menu.
const pipAgentsWords=()=>agentsUi.slots>=ULTRA_SLOTS?`Up to ${agentsUi.slots} at once (Ultra).`:agentsUi.slots>1?`Up to ${agentsUi.slots} at once.`:'One at a time.';
function pipAgentsTabMarkup(model){
 return `<div class="composer-agents" role="tabpanel" aria-labelledby="chat-model-tab-agents"><div class="composer-model-options" role="listbox" aria-label="What its sub-agents run on"><div class="composer-model-option dgc-menu-row composer-agents-own" role="option" aria-selected="true"><span class="composer-model-check dgc-menu-icon">${composerIcon('check')}</span><span class="composer-model-row">This Pip’s model<small>Now: ${esc(model||'not chosen yet')}</small></span></div></div><p class="composer-scope composer-agents-note">${esc(pipAgentsWords())}${agentsUi.slots>=ULTRA_SLOTS?'':' Ultra on the slider lets up to 4 work at once.'} They think as hard as this Pip does.</p></div>`;
}
const ultraOffered=()=>convOn()&&agentsUi.pip===S.selected;
const pipUltra=()=>ultraOffered()&&agentsUi.slots>=ULTRA_SLOTS;
async function setPipUltra(on){
 if(!ultraOffered()||!usable()||pipUltra()===on)return;
 const pip=S.selected,token=scope(),was=agentsUi.slots;
 agentsUi.slots=on?ULTRA_SLOTS:1;ultraBusy=true;render();
 try{const said=await send('set_pip_agents',{pip_id:pip,slots:on?ULTRA_SLOTS:1});if(token===scope()&&agentsUi.pip===pip&&Number.isSafeInteger(said?.slots)&&said.slots>0)agentsUi.slots=said.slots;}
 catch(error){if(token===scope()&&agentsUi.pip===pip){agentsUi.slots=was;setError(error);}}
 finally{ultraBusy=false;if(token===scope())render();}
}
async function loadAgents(){
 if(!convOn()||!usable())return;
 const token=scope(),sequence=++agentsUi.seq,pip=S.selected;
 try{const page=agentsPage(await send('list_pip_agents',{pip_id:pip}),pip);if(token!==scope()||sequence!==agentsUi.seq)return;
  const before=agentsUi.pip===pip?JSON.stringify(agentsUi.list):'';const slotsBefore=agentsUi.slots;agentsUi.pip=pip;agentsUi.list=page.agents;if(!ultraBusy)agentsUi.slots=page.slots;
  for(const a of page.agents)if(a.run_id&&(AGENT_LIVE.includes(a.state)||agentsUi.stepsOpen.has(a.id)||agentsUi.card===a.id))void loadAgentSteps(a);
  if(JSON.stringify(page.agents)!==before||agentsUi.slots!==slotsBefore)render();else renderAgentMap();}
 catch{/* the pill and the map keep what they had */}
 finally{if(token===scope())agentsTick();}
}
// While one of its sub-agents works the fixes and the sub-agents are read again every three seconds: the row, the
// pill and the map follow it without a click, and stop asking once nothing works.
function agentsTick(){
 window.clearTimeout(agentsUi.timer);agentsUi.timer=0;
 if(disposed||!convOn()||![...agentsNow(),...fixAgents()].some(a=>AGENT_LIVE.includes(a.state)))return;
 agentsUi.timer=window.setTimeout(()=>{agentsUi.timer=0;if(disposed||!convOn())return;if(!S.visible||document.hidden||S.tab!=='chat'){agentsTick();return;}void loadFlow();},3000);
}
// A sub-agent's steps, from its run's activity: each thing it did, in words; the newest is what it is doing now.
async function loadAgentSteps(a){
 if(!a?.run_id||!usable())return;
 let st=agentsUi.steps.get(a.id);
 if(!st||st.run!==a.run_id){st={run:a.run_id,cursor:0,lines:[],loading:false,error:''};agentsUi.steps.set(a.id,st);}
 if(st.loading)return;
 const token=scope(),identity={id:a.run_id,pip_id:S.selected,workspace_id:S.pip?.workspace_id};st.loading=true;let changed=false;
 try{for(let n=0;n<6;n++){
   const after=st.cursor,page=activityPage(await send('list_pip_run_activity',{run_id:a.run_id,after}),identity,after);
   if(token!==scope()||agentsUi.steps.get(a.id)!==st)return;
   st.cursor=page.next_cursor;
   for(const event of page.events){const line=activityText(activityParts(event));if(line&&st.lines.at(-1)!==line){st.lines.push(line);changed=true;}}
   if(st.lines.length>200)st.lines.splice(0,st.lines.length-200);
   if(!page.has_more)break;}
  st.error='';}
 catch{if(token===scope()&&!st.lines.length){st.error='Its steps couldn’t be read.';changed=true;}}
 finally{st.loading=false;
  if(token===scope()&&agentsUi.steps.get(a.id)===st){const now=st.lines.at(-1)||'';if(now&&agentsUi.doing.get(a.id)!==now){agentsUi.doing.set(a.id,now);changed=true;}if(changed||agentsUi.stepsOpen.has(a.id)||agentsUi.card===a.id)render();}}
}
const agentSteps=a=>{const st=agentsUi.steps.get(a.id);return {lines:st?.lines||[],loading:!st||st.loading&&!st.lines.length,error:st?.error||''};};
function toggleAgentSteps(id){
 const a=agentOf(id);if(!a)return;
 if(agentsUi.stepsOpen.has(id))agentsUi.stepsOpen.delete(id);else{agentsUi.stepsOpen.add(id);void loadAgentSteps(a);}
 render();document.querySelector(`.pip-agent-row [data-agent-steps="${id}"]`)?.focus({preventScroll:true});
}
async function stopAgent(id){
 if(agentsUi.stopping||!usable()||archived())return;const token=scope(),pip=S.selected;agentsUi.stopping=id;render();
 try{await send('stop_pip_agent',{pip_id:pip,agent_id:id});}catch(error){if(token===scope())setError(error);}
 finally{if(token===scope()){agentsUi.stopping='';render();await loadFlow();}}
}
// After the last try: Try again (a fresh sub-agent job for what isn't fixed) or Leave it (never asked again).
async function retryFix(id,again){
 const fix=flowNow()?.fixes.find(f=>f.id===id);if(!fix||flow.busy||!usable()||archived())return;
 const token=scope(),pip=S.selected;flow.busy={id,what:again?'again':'leave'};flow.errors.delete(id);render();
 try{const said=await send('retry_pip_fix',{pip_id:pip,fix_id:id,again});if(token!==scope())return;
  try{const now=fixAnswer(said,id);flow.value={...flow.value,fixes:flow.value.fixes.map(f=>f.id===id?now:f)};}catch{/* read again below */}
  void loadAttention();}
 catch(error){if(token===scope())flow.errors.set(id,errorText(error));}
 finally{if(flow.busy?.id===id)flow.busy=null;if(token===scope()){render();void loadFlow();}}
}
// The agent map for this Pip, drawn in a layer of its own over the view (so a redraw of the chat never disturbs it).
function agentMapPip(){return {name:S.pip.name,folder:pipFolderName(),model:(t=>t==='Default'?'Default model':t)(chipModel(S.pip.model_choice,S.pip.model_choice?.mode==='model'?S.pip.model_choice.model:'').text||''),busy:!!S.chatActiveRun};}
function renderAgentMap(){
 let host=document.getElementById('agent-map-root');
 const open=agentsUi.map&&!disposed&&convOn()&&S.tab==='chat'&&!S.review&&agentsUi.pip===S.selected;
 const app=document.getElementById('app');
 if(!open){agentsUi.map=false;agentsUi.card='';if(app?.inert)app.inert=false;if(host?.firstChild){host.replaceChildren();agentsUi.drawn='';}return;}
 if(!host){host=document.createElement('div');host.id='agent-map-root';shell.append(host);}
 const card=agentsUi.card?agentsUi.list.find(a=>a.id===agentsUi.card)||null:null;if(!card)agentsUi.card='';
 const off=archived()||!usable(),pip=agentMapPip(),doingOf=id=>agentsUi.doing.get(id)||'';
 const sig=JSON.stringify([agentsUi.list.map(a=>[a.id,a.state,a.try,a.notes,a.model,a.held,doingOf(a.id)]),agentsUi.earlier,agentsUi.card,card?agentSteps(card):0,agentsUi.stopping,off,pip]);
 if(sig===agentsUi.drawn)return;
 const still=!!agentsUi.drawn,active=document.activeElement,key=host.contains(active)?['agentCard','agentStop','agentMapClose','agentCardBack','agentEarlier'].map(k=>active.dataset?.[k]!==undefined?`[data-${k.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}${active.dataset[k]?`="${active.dataset[k]}"`:''}]`:'').find(Boolean)||'':null;
 const face=pipAvatar(S.pip,'idle','agent-map',pipType(S.pip,S.types)||characterType(S.pip.pip_type));
 host.innerHTML=agentMapMarkup(agentsUi.list,{esc,pip,face,doingOf,earlierOpen:agentsUi.earlier,still})
  +(card?agentCardMarkup(card,{esc,pip,doing:doingOf(card.id),steps:agentSteps(card),stopping:agentsUi.stopping===card.id,off,still:still&&agentsUi.cardDrawn===card.id}):'');
 agentsUi.drawn=sig;agentsUi.cardDrawn=card?.id||'';
 if(app)app.inert=true;
 const map=host.querySelector('.pip-agent-map');if(map)map.inert=!!card;
 const top=host.querySelector(card?'.pip-agent-card':'.pip-agent-map');
 if(key!==null||!still)amFocus(key&&top.querySelector(key)||top.querySelector('.agent-map'));   // (the window itself at first, then Tab and the arrows)
}
function openAgentMap(){
 if(!convOn()||!agentsNow().length)return;
 S.composerPanel='';agentsUi.map=true;agentsUi.card='';agentsUi.drawn='';render();void loadAgents();
}
function closeAgentMap(){
 if(!agentsUi.map)return;agentsUi.map=false;agentsUi.card='';render();document.getElementById('chat-agents')?.focus({preventScroll:true});
}
function openAgentCard(id){const a=agentsUi.list.find(x=>x.id===id);if(!a)return;agentsUi.card=id;void loadAgentSteps(a);renderAgentMap();}
function closeAgentCard(){const id=agentsUi.card;if(!id)return;agentsUi.card='';renderAgentMap();amFocus(document.querySelector(`.pip-agent-map [data-agent-card="${id}"]`));}
// Times in a sub-agent's row, its line in the map and its card move on each second, in place.
const agentsClock=window.setInterval(()=>{
 if(disposed||document.hidden)return;const now=Date.now();
 for(const el of document.querySelectorAll('[data-agent-since]')){const text=took(now-Number(el.dataset.agentSince));if(el.textContent!==text)el.textContent=text;}
 for(const el of document.querySelectorAll('[data-agent-meta]')){const a=agentsUi.list.find(x=>x.id===el.dataset.agentMeta);if(!a)continue;const text=mapMeta(a,{doing:agentsUi.doing.get(a.id)||'',pip:S.pip?.name,now}).join(' · ');if(el.textContent!==text)el.textContent=text;}
 for(const el of document.querySelectorAll('[data-agent-card-meta]')){const a=agentsUi.list.find(x=>x.id===el.dataset.agentCardMeta);if(!a)continue;const text=cardMeta(a,{doing:agentsUi.doing.get(a.id)||'',pip:S.pip?.name,now});if(el.textContent!==text)el.textContent=text;}
},1000);
disposers.push(()=>{window.clearInterval(agentsClock);window.clearTimeout(agentsUi.timer);});
document.addEventListener('click',event=>{
 const at=sel=>event.target.closest?.(sel);
 let n;
 if(changeUi.menu&&!at('[data-change-menu],.pip-change-menu')){changeUi.menu='';render();}
 // (A file in what it found is Work's file link; it opens in the Pip's folder, at its line.)
 if((n=at('.pip-said [data-flow-file]'))){event.preventDefault();event.stopImmediatePropagation();flowOpenFile(n.dataset.flowFile,n.dataset.flowLine);return;}
 if((n=at('#chat-agents'))){if(agentsUi.map)closeAgentMap();else openAgentMap();return;}
 if((n=at('[data-agent-steps]'))){toggleAgentSteps(n.dataset.agentSteps);return;}
 if((n=at('[data-agent-stop]'))){void stopAgent(n.dataset.agentStop);return;}
 if((n=at('[data-retry-again]'))){void retryFix(n.dataset.retryAgain,true);return;}
 if((n=at('[data-retry-leave]'))){void retryFix(n.dataset.retryLeave,false);return;}
 if((n=at('[data-change-fold]'))){const id=n.dataset.changeFold;if(changeUi.folded.has(id))changeUi.folded.delete(id);else changeUi.folded.add(id);render();document.querySelector(`[data-change-fold="${id}"]`)?.focus({preventScroll:true});return;}
 if((n=at('[data-change-menu]'))){const id=n.dataset.changeMenu;changeUi.menu=changeUi.menu===id?'':id;render();(changeUi.menu?document.querySelector('.pip-change-menu .dgc-menu-row'):document.querySelector(`[data-change-menu="${id}"]`))?.focus({preventScroll:true});return;}
 if(at('.pip-change-menu [data-project-discard]')){changeUi.menu='';return;}
 if(at('[data-agent-map-close]')){closeAgentMap();return;}
 if(at('[data-agent-card-back]')){closeAgentCard();return;}
 if(at('[data-agent-earlier]')){agentsUi.earlier=!agentsUi.earlier;renderAgentMap();amFocus(document.querySelector('.pip-agent-map [data-agent-earlier]'));return;}
 if((n=at('.pip-agent-map [data-agent-card]'))){openAgentCard(n.dataset.agentCard);return;}
 // A click on the dimmed chat beside the map closes what is on top.
 if(event.target.classList?.contains('pip-agent-card')){closeAgentCard();return;}
 if(event.target.classList?.contains('pip-agent-map')){closeAgentMap();return;}
});
{const pointed=()=>{agentsByPointer=true;};root.addEventListener('pointerdown',pointed,true);disposers.push(()=>root.removeEventListener('pointerdown',pointed,true));
const keys=event=>{
 agentsByPointer=false;
 if(changeUi.menu&&event.key==='Escape'){const id=changeUi.menu;event.preventDefault();event.stopPropagation();changeUi.menu='';render();document.querySelector(`[data-change-menu="${id}"]`)?.focus({preventScroll:true});return;}
 if(!agentsUi.map)return;
 const top=document.querySelector(agentsUi.card?'.pip-agent-card':'.pip-agent-map');if(!top)return;
 if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(agentsUi.card)closeAgentCard();else closeAgentMap();return;}
 const active=document.activeElement;
 if(event.key==='Tab'){const stops=[...top.querySelectorAll('button:not(:disabled),summary,[tabindex="0"]')].filter(b=>b.tabIndex>=0);if(!stops.length)return;
  const i=stops.indexOf(active),next=event.shiftKey?(i<=0?stops.at(-1):stops[i-1]):(i<0||i===stops.length-1?stops[0]:stops[i+1]);event.preventDefault();event.stopPropagation();next.focus();return;}
 if((event.key==='ArrowDown'||event.key==='ArrowUp')&&(active?.classList?.contains('am-row')||active?.classList?.contains('agent-map'))&&!agentsUi.card){const rows=[...top.querySelectorAll('button.am-row')],i=rows.indexOf(active),next=i<0?rows[0]:rows[i+(event.key==='ArrowDown'?1:-1)];
  event.preventDefault();event.stopPropagation();if(next){for(const r of rows)r.tabIndex=r===next?0:-1;next.focus();}}
};root.addEventListener('keydown',keys,true);disposers.push(()=>root.removeEventListener('keydown',keys,true));}
async function loadFlow(){
 if(!flowOn()||!usable())return;
 const token=scope(),sequence=++flow.seq,pip=S.selected;
 try{const page=fixesPage(await send('list_pip_fixes',{pip_id:pip}),pip);if(token!==scope()||sequence!==flow.seq)return;
  const before=flow.pip===pip?JSON.stringify(flow.value):'';flow.pip=pip;flow.value=page;flow.error='';
  // A fix whose change is ready is drawn with its change: that list is read with it.
  if(page.fixes.some(f=>f.change_id&&!S.projectChanges.some(c=>c.id===f.change_id)))void loadProjectChanges();
  if(convOn()){for(const f of page.fixes)if(f.agent?.run_id&&AGENT_LIVE.includes(f.agent.state))void loadAgentSteps(f.agent);void loadAgents();}
  if(JSON.stringify(page)!==before)render();}
 catch(error){if(token===scope()&&sequence===flow.seq){flow.error=errorText(error);render();agentsTick();}}   // (one failed read doesn't end the watch on a working sub-agent)
}
// The folder this Pip works in, by its name and whole.
function pipFolderRow(pip=S.pip){return pip&&!personalPip(pip)?folderOfSpace(pip.workspace_id):null;}
function pipFolderName(pip=S.pip){return pipFolderRow(pip)?.name||(pip&&!personalPip(pip)?spaceName(pip.workspace_id):'')||flowNow()?.folder||'';}
function flowFixFor(runId){const list=(flowNow()?.fixes||[]).filter(f=>f.run_id===runId);return list.at(-1)||null;}
// The change card of a fix: the project-change card, drawn with its fix and nowhere else in the chat.
function flowChangeIds(){return new Set((flowNow()?.fixes||[]).map(f=>f.change_id).filter(Boolean));}
function flowChangeCard(fix){
 const change=fix.change_id?S.projectChanges.find(c=>c.id===fix.change_id):null;if(!change)return '';
 const off=archived()||!usable();
 return projectCardMarkup({...change,...(fix.tests&&!change.tests?{tests:fix.tests}:{})},{esc,open:projectOpen,diffs:projectDiffs,busy:projectBusy?.id===change.id?projectBusy.what:'',off:off||(!!projectBusy&&projectBusy.id!==change.id),
  confirm:projectConfirm===change.id,note:projectNotes.get(change.id)||'',error:projectErrors.get(change.id)||'',one:true,canCommit:S.apiVersion>=FLOW_API,
  ...(convOn()?{look:'work',folded:changeUi.folded.has(change.id),menu:changeUi.menu===change.id}:{})});
}
/** Under a check's post: its findings as one card, then what became of them: the Allow card, the fix at work, its change. */
function flowUnderPost(p){
 const fix=flowFixFor(p.run_id),found=fix?.findings.length?fix.findings:fixesPage({pip_id:S.selected,fixes:[{id:'pipfix_'+'0'.repeat(32),state:'ask',count:0,digest:'-',findings:Array.isArray(p.findings)?p.findings.slice(0,50):[]}]},S.selected).fixes[0]?.findings||[];
 const total=Number.isSafeInteger(p.total)&&p.total>=found.length?p.total:found.length;
 if(convOn())return (p.outcome==='findings'?foundListMarkup({runId:p.run_id,findings:found,total},{esc,off:!usable()}):'')+(fix?flowFixMarkup(fix):'');
 const card=p.outcome==='findings'?findingsCardMarkup({runId:p.run_id,findings:found,total,counts:record(p.found)?p.found:null,name:S.pip.name},{esc,off:!usable()}):'';
 return card+(fix?flowFixMarkup(fix):'');
}
const ENDED_SAYS={unchanged:'I looked and found nothing to change.',failed:'The fix didn’t finish.',stopped:'The fix was stopped. Nothing in your folder was changed.',interrupted:'The fix was interrupted. Nothing in your folder was changed.',undone:'The fix was undone.',discarded:'You discarded the fix.'};
/** One fix in the conversation (Pips API 97): the Pip's question and the permission card; then the answered line, its
 *  one line that it handed the job over, its sub-agent's row, its words from its check, and the change. */
function convFixMarkup(fix){
 const folder=pipFolderName(),off=archived()||!usable(),busy=flow.busy?.id===fix.id?flow.busy.what:'',error=flow.errors.get(fix.id)||'',hold=off||!!flow.busy&&!busy;
 // (Its question stays above the answered line while this view remembers it: DGC says it only while it asks.)
 if(fix.state==='ask'){if(fix.message)askedWords.set(fix.id,fix.message);return saidMarkup(fix.message,{esc})+askCardMarkup(fix,{esc,folder,off:hold,busy,error});}
 const answered=(fix.by.startsWith('pip-level:')?'':saidMarkup(askedWords.get(fix.id)||'',{esc}))+answeredMarkup(fix,{esc,folder,clock:t=>new Date(t).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})});
 if(fix.state==='declined')return answered+(error?`<p class="dgc-card-error" role="alert">${esc(error)}</p>`:'');
 const a=fix.agent,type=pipType(S.pip,S.types)||characterType(S.pip.pip_type);
 const row=a?agentRowMarkup(a,{esc,face:pipAvatar(S.pip,'idle',`agent-${a.id}`,type),doing:agentsUi.doing.get(a.id)||'',pip:S.pip.name,canWatch:computerState.pip===S.selected&&!!computerState.value?.granted,
  stopping:agentsUi.stopping===a.id,off,steps:agentsUi.stepsOpen.has(a.id)?agentSteps(a):null,watchOf:fix.id}):'';
 const handed=handedMarkup(fix,{esc,waits:!S.runner?.online||!!S.runner?.paused});
 if(FIX_LIVE.includes(fix.state))return answered+handed+row;
 const words=saidMarkup(fix.message||ENDED_SAYS[fix.state]||'',{esc,of:fix.id});
 const change=['ready','applied','held'].includes(fix.state)?flowChangeCard(fix)||(fix.state==='ready'?'<p class="pip-answered-line" role="status">Its change is ready. Reading it…</p>':''):'';
 const asks=a?.state==='asked'?retryAskMarkup(fix,{esc,off:hold,busy,error}):'';
 const again=!asks&&['failed','stopped','interrupted'].includes(fix.state)?`<p class="pip-answered-line"><button type="button" class="pip-link pip-quiet-link" data-flow-allow="${esc(fix.id)}"${hold?' disabled':''}>Allow it again</button></p>`:'';
 return answered+handed+row+words+change+asks+again+(error&&!asks?`<p class="dgc-card-error" role="alert">${esc(error)}</p>`:'');
}
function flowFixMarkup(fix){
 if(convOn())return convFixMarkup(fix);
 const folder=pipFolderName(),off=archived()||!usable(),busy=flow.busy?.id===fix.id?flow.busy.what:'',error=flow.errors.get(fix.id)||'',note=flow.notes.get(fix.id)||'';
 const said=note?`<p class="pip-found-line" role="status">${esc(note)}</p>`:'';
 if(fix.state==='ask')return (fix.message?`<article class="pip-message assistant dgc pip-found-says"><div class="answer split"><div class="message-body text reply-part"><p>${esc(fix.message)}</p></div></div></article>`:'')
  +fixAskMarkup(fix,{esc,folder,off:off||!!flow.busy&&!busy,busy,menu:flow.menu===fix.id,error})+said;
 const decided=fixDecidedLine(fix,{esc,folder,clock:t=>new Date(t).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})});
 if(fix.state==='declined')return decided+said;
 if(FIX_LIVE.includes(fix.state))return decided+fixingMarkup(fix,{esc,off,stopping:flow.stopping===fix.fix_run_id,canWatch:computerState.pip===S.selected&&!!computerState.value?.granted})+said;
 if(['ready','applied','held'].includes(fix.state))return decided+(flowChangeCard(fix)||(fix.state==='ready'?'<p class="pip-found-line" role="status">Its change is ready. Reading it…</p>':''))+said;
 return decided+fixEndedLine(fix,{esc})+said;
}
// A fix whose check is not among the runs drawn (an older one, or another conversation) still shows, at the chat's end.
function flowTailMarkup(){
 const page=flowNow();if(!page)return '';
 const drawn=new Set(chatPosts()?S.posts.map(p=>p.run_id):[]);
 return page.fixes.filter(f=>!f.run_id||!drawn.has(f.run_id)).filter(f=>!['discarded','undone','unchanged','declined'].includes(f.state)).map(flowFixMarkup).join('')
  +(flow.error?`<p class="app-link-note" role="alert">${esc(flow.error)}</p>`:'');
}
// What only you can do: one line at the top of its chat, and its cards under it when shown.
function flowPinnedMarkup(){
 const page=flowNow();if(!page?.waiting.length)return '';
 const line=waitingLineMarkup(page.waiting,{esc,open:flow.waitingOpen}),off=archived()||!usable();
 // (What was just answered keeps its line under the pinned one while it is open, with Undo where there is one.)
 const cards=flow.waitingOpen?page.waiting.map(w=>waitingCardMarkup(w,{esc,off:off||!!flow.busy&&flow.busy.id!==w.id,busy:flow.busy?.id===w.id?flow.busy.what:'',error:flow.errors.get(w.id)||''})).join(''):'';
 if(!line&&!cards)return '';
 return `<div class="pip-found-pinned">${line}${cards?`<div class="pip-found-pinned-list" id="pip-waiting-list">${cards}</div>`:''}</div>`;
}
function flowLive(){return (flowNow()?.fixes||[]).find(f=>FIX_LIVE.includes(f.state))||null;}
async function flowDecide(id,allow){
 const fix=flowNow()?.fixes.find(f=>f.id===id);if(!fix||flow.busy||!usable()||archived())return;
 const token=scope(),pip=S.selected;flow.busy={id,what:allow?'allow':'no'};flow.errors.delete(id);flow.menu='';render();
 try{const now=fixAnswer(await send('decide_pip_fix',{pip_id:pip,fix_id:id,expected_digest:fix.digest,allow}),id);if(token!==scope())return;
  flow.value={...flow.value,fixes:flow.value.fixes.map(f=>f.id===id?now:f)};void loadAttention();}
 catch(error){if(token===scope())flow.errors.set(id,errorText(error));}
 finally{if(flow.busy?.id===id)flow.busy=null;if(token===scope()){render();void loadFlow();}}
}
// "Start a helper with Work tools": a helper with a Work session's tools on the real folder, shown in this chat. DGC
// asks first (an Allow card) at Ask me first and Approve for me; it says which in its answer.
async function flowHelper(id){
 const fix=flowNow()?.fixes.find(f=>f.id===id);if(!fix||flow.busy||!usable()||archived())return;
 const token=scope(),pip=S.selected;flow.busy={id,what:'helper'};flow.errors.delete(id);flow.menu='';render();
 try{const answer=await send('start_pip_work_helper',{pip_id:pip,fix_id:id});if(token!==scope())return;
  flow.notes.set(id,answer?.asks===true?'It asks before it starts a helper on your real files. Its card is below.':'A helper with Work tools is starting on your real files.');}
 catch(error){if(token===scope())flow.errors.set(id,errorText(error));}
 finally{if(flow.busy?.id===id)flow.busy=null;if(token===scope()){render();void loadFlow();void refreshComputer();}}
}
async function flowStop(runId){
 if(flow.stopping||!usable())return;const token=scope();flow.stopping=runId;render();
 try{await send('cancel_pip_run',{run_id:runId});}catch(error){if(token===scope())setError(error);}
 finally{if(token===scope()){flow.stopping='';render();void loadFlow();}}
}
async function flowWaitingAnswer(id,answer){
 const waits=flowNow()?.waiting.find(w=>w.id===id);if(!waits||flow.busy||!usable()||!['done','later','not_a_problem','undo'].includes(answer))return;
 const token=scope(),pip=S.selected;flow.busy={id,what:answer};flow.errors.delete(id);render();
 try{const page=fixesPage({pip_id:pip,fixes:[],...(await send('answer_pip_waiting',{pip_id:pip,waiting_id:id,answer}))},pip);if(token!==scope())return;
  flow.value={...flow.value,waiting:page.waiting};void loadAttention();}
 catch(error){if(token===scope())flow.errors.set(id,errorText(error));}
 finally{if(flow.busy?.id===id)flow.busy=null;if(token===scope())render();}
}
// A finding's file, opened in an editor tab at its line: in the Pip's own folder, wherever this window is.
function flowOpenFile(path,line){
 const folder=pipFolderRow()?.folder||'',whole=folder&&!/^([A-Za-z]:)?[\\/]/.test(path)?`${folder.replace(/[\\/]+$/,'')}/${path}`:path;
 vscode.postMessage({type:'openFile',path:whole,...(Number(line)>0?{line:Number(line)}:{})});
}
// Review: every file of the change opened in place, the first one in view.
function projectReview(id){
 const change=S.projectChanges.find(c=>c.id===id);if(!change)return;
 const files=change.files.filter(f=>f.change!=='link'),all=files.length&&files.every(f=>projectOpen.has(`${id}|${f.path}`));
 for(const f of files){const key=`${id}|${f.path}`;if(all)projectOpen.delete(key);else if(!projectOpen.has(key)){projectOpen.add(key);void loadProjectDiff(id,f.path);}}
 render();
}
async function projectCommit(id){
 const change=S.projectChanges.find(c=>c.id===id);if(!change||!usable()||projectBusy||archived())return;
 const token=scope(),pip=S.selected;projectBusy={id,what:'commit'};projectErrors.delete(id);render();
 try{const decided=projectAnswer(await send('commit_pip_project_change',{pip_id:pip,change_id:id}),id);if(token!==scope()||S.selected!==pip)return;S.projectChanges=S.projectChanges.map(c=>c.id===id?decided:c);}
 catch(error){if(token===scope()&&S.selected===pip)projectErrors.set(id,errorText(error));}
 finally{if(projectBusy?.id===id)projectBusy=null;if(token===scope())render();}
}
// ---- Every Pip in the one page and chat (One Pips) ----
// A Pip with a folder opens in the page a Personal Pip has: its header and menu, its chat, its settings page. What
// only it has is in that page: Run now in its header's menu; where it works, what it reads, when it runs, and its
// version history and approvals in its settings; its reports as a table. No owner session: its chat is its home.
function pagePip(pip=S.pip){return !!pip&&(personalPip(pip)||onePips());}
// Its own computer: a Personal Pip's as before; a Pip with a folder where DGC says it has one (get_pip_computer granted,
// Pips API 95: the machine runs boxes). One on a machine without boxes has none, and nothing of it shows.
function mayHaveBox(pip=S.pip){return !!pip&&(personalPip(pip)||onePips()&&S.apiVersion>=95);}
function folderBox(){return !!S.pip&&!personalPip()&&onePips()&&computerState.pip===S.selected&&computerState.value?.granted===true;}
function reportsName(){return onePips()&&S.pip&&!personalPip()?'Reports':historyName('Results');}
function oneReportsMarkup(){
 const runs=S.runs.filter(r=>(r.manifest?.run_kind||'audit')!=='conversation'),posts=S.postsPip===S.selected?S.posts:[];
 const rows=runs.map(r=>reportRow(r,posts.find(p=>p.run_id===r.id)||null));
 const action=runAction(),blocked=action?runBlocked():'';
 return `<section class="section pip-reports-section"><div class="section-head"><h2>Reports</h2>${action?`<button type="button" id="pip-run-now" class="primary" title="${esc(blocked||action.title)}"${blocked?' disabled':''}>${esc(action.label)}</button>`:''}</div>`
  +`<p class="muted">Every check, newest first. What it found is also in its chat, where you can ask about it.</p>`
  +reportsTableMarkup(rows,{esc,sort:one.reportsSort,current:S.runId,when:t=>t?shortDate(new Date(t).toISOString()):'',off:!usable(),name:S.pip.name})+'</section>'+reportMarkup()+checkpointHistoryMarkup();
}
// What only a Pip with a folder has, on its settings page.
function folderPartsMarkup(p){
 const row=pipFolderRow(p),name=row?.name||spaceName(p.workspace_id)||'its folder',Pick=globalThis.DgcFolderPick,boxed=folderBox();
 const branch=typeof p.source_ref==='string'&&p.source_ref&&p.source_ref!=='HEAD'&&p.source_policy?.mode!=='working_tree'?p.source_ref:'';
 const reads=branch?`Reads branch ${branch}: its committed files. What it changes always waits for your Apply.`
  :boxed?'Your files as they are, in its own copy. Not what Git ignores, such as .env.':currentTree()?'Your current files. It only reads them.':'The committed code. It only reads it.';
 let runs='Only when you ask';try{runs=p.event_trigger?eventTriggerLabel(p.event_trigger):p.schedule?scheduleLabel(p.schedule):runs;}catch{runs='On a schedule';}
 const chev='<span class="row-chevron" aria-hidden="true">›</span>';
 return `<section class="pip-page-group pip-folder-parts" aria-label="Its folder"><h3 class="pip-page-label">Its folder</h3>`
  +`<div class="pip-page-row static"><span class="row-words"><strong>Works in</strong><small class="pip-folder-where" title="${esc(row?.folder||name)}">${row&&row.exists===false?'<span class="pip-row-folder-note">Folder not found</span> ':''}${row&&Pick?Pick.pathHtml(row.shown,row.folder):esc(name)}</small></span></div>`
  +`<div class="pip-page-row static"><span class="row-words"><strong>What it reads</strong><small>${esc(reads)}</small></span></div>`
  +`<button type="button" class="pip-page-row" data-tab="schedule"><span class="row-words"><strong>When it runs</strong><small class="row-preview">${esc(runs)}</small></span>${chev}</button>`
  +`<button type="button" class="pip-page-row" data-tab="runs"><span class="row-words"><strong>Reports</strong><small class="row-preview">What each check found, as a table</small></span>${chev}</button>`
  +`<button type="button" class="pip-page-row" data-tab="revisions"><span class="row-words"><strong>Version history and approvals</strong><small class="row-preview">Every change to it, and who approved it</small></span>${chev}</button></section>`;
}
// Choosing Do it all says what it means first (his call, like Work's auto mode). Continue sets it; Cancel leaves it.
const FULL_WARNING='A Pip on Do it all acts without asking. It can send anything it sees, including your code, to the web. It applies its fixes to your folder, and it can start a helper with full Work tools on your real files, including ones Git ignores such as .env. Payments follow the limit you set.';
function chooseLevel(level,how={}){
 if(levelState.pip===S.selected&&levelState.value?.level===level)return;
 if(level==='full'&&onePips()){
  openReview({title:`Put ${S.pip?.name||'this Pip'} on Do it all?`,description:FULL_WARNING,body:'',confirm:'Continue',fullLevel:true,refocus:how.refocus||'',request:{}});
  return;
 }
 void setLevel(level,how);
}
function pageView(){return S.tab==='job'&&!!S.pip&&pagePip()&&S.apiVersion>=43&&!remoteHost;}
function simpleTabContent(){
 if(pageView())return pipPageMarkup();
 if(S.tab==='runs'&&onePips()&&S.pip&&!personalPip()&&!remoteHost)return oneReportsMarkup();
 if(S.tab==='memory')return memoriesMarkup()+statementsMarkup();
 if(S.tab==='notifications')return notificationsMarkup();
 if(S.tab==='context')return contextMarkup();
 if(S.tab==='handoffs')return handoffsMarkup();
 return S.tab==='job'?jobSettingsMarkup():S.tab==='revisions'?revisionsMarkup():S.tab==='schedule'?scheduleMarkup():runsMarkup();
}
// A Project Pip's status sits beside its name on its chat, as it sat under its name on the old page: what its latest
// run found ("Today’s audit: 5 findings"), which goes to that run's post in the chat.
// Run now, for a Project Pip (reported 24 Oct): where a Personal Pip has its main action, its computer, one click
// from its chat. It runs what History's button runs (an audit, a draft, its live-data commands or its approved command
// plan) with the same checks; a Patch runs only on a handoff you approve, and a Pulse with no command plan has none. While
// one of its runs is going it says so, and opens that run in History.
function runAction(){
 const p=S.pip;if(!p||personalPip())return null;
 if(livePip(p))return {label:'Run now',title:'Run its approved read-only commands now'};
 if(pulsePip(p)){let plan=false;try{plan=!!pulsePlan(p.verification_plan);if(plan)pulseRunPins(p);}catch{plan=false;}return plan?{label:'Run approved commands',title:'Run its approved commands now, exactly as approved'}:null;}
 if(executionPip(p))return null;
 if(documentationPip(p))return {label:'Create draft',title:'Write a documentation draft now'};
 return {label:'Run audit',title:'Run an audit of the code now'};
}
// Its run that is going now, not a reply in its chat.
function activeOwnRun(){const a=S.pip?.active_run;return record(a)&&typeof a.id==='string'&&a.run_kind!=='conversation'?a:S.runs.find(r=>active(r.status)&&r.manifest?.run_kind!=='conversation')||null;}
// Why Run now can't start a run, in words for its tooltip; '' when it can.
function runBlocked(){
 const p=S.pip,live=livePip(p);
 if(live&&S.apiVersion<60)return 'Update DGC to run a live-data Pip.';
 if(!live&&!supportedSource())return 'It can’t run on its current source here. Check its Settings.';
 if(!S.runner?.online)return 'Pips aren’t running. Start Pips to run it.';
 if(S.runner.paused)return 'Pips are stopped on this computer. Resume Pips to run it.';
 if(p.status==='archived')return 'Archived. Restore it in Settings to run it.';
 if(p.status!=='active')return 'Paused. Resume it in Settings to run it.';
 if(!live&&!pulsePip(p)&&!pipType(p,S.types)?.available)return 'This editor doesn’t know this kind of Pip. Update the DGC extension to run it.';
 if(p.active_run||S.runs.some(r=>active(r.status)))return 'It’s answering in its chat. Run it when that’s done.';
 if(S.busy||!usable())return 'Busy. Try again in a moment.';
 return '';
}
function runNowMarkup(){
 const action=runAction();if(!action)return '';
 const going=activeOwnRun();
 if(going)return `<button type="button" id="pip-run-open" class="topbar-running" data-run-id="${esc(going.id)}" title="Running now. Open it in History"><span class="topbar-spinner" aria-hidden="true"></span>Running…</button>`;
 const blocked=runBlocked();
 return `<button type="button" id="pip-run-now" class="topbar-icon" aria-label="${esc(action.label)}" title="${esc(blocked||action.title)}"${blocked?' disabled':''}>${simpleIcon('play')}</button>`;
}
function pipSetupNotes(){
 const unknown=S.pip&&!pipType(S.pip,S.types)?'<p class="notice error simple-note">This editor doesn’t know this kind of Pip. You can still read its reports; update the DGC extension to use it.</p>':'';
 return unknown;
}
// ---- Several conversations per Pip (Pips API 79; src/pipConversations.js) ----
// A Pip's chat shows one of its conversations. `convShown` says which for each Pip (none: its first, and then a request
// names no conversation, exactly as before API 79). Everything this page keeps per Pip for its chat (the draft and its
// marks, the queue, pictures and files waiting to go, a request to send again) is the shown conversation's; what the
// others keep waits in `convStash`, with their messages and where they were scrolled to, and comes back on a switch.
const convShown=new Map(),convStash=new Map(),convDrafts=new Map();
Object.defineProperty(S,'conv',{get:()=>convShown.get(S.selected)||'',enumerable:false});
const convState={pip:'',list:null,seq:0,ui:'',menu:false,more:'',renaming:'',renameText:'',archivedOpen:false,newStep:false,newChoice:'use',busy:false,error:'',collapsed:savedView?.conversations_hidden===true};
let convScroll=null,convTitling=new Set();
const convKey=(pip,conv)=>`${pip}#${conv||''}`;
const convMaps=()=>[chatDrafts,chatMarks,chatQueues,chatImages,chatFiles,chatRequests,chatReplies];
function convsOn(){return S.apiVersion>=79&&!remoteHost&&!!S.selected;}
function convList(){return convsOn()&&convState.pip===S.selected&&Array.isArray(convState.list)?convState.list:null;}
function convUi(){if(convState.ui!==S.selected){Object.assign(convState,{ui:S.selected,menu:false,more:'',renaming:'',renameText:'',archivedOpen:false,newStep:false,newChoice:'use',busy:false,error:''});}return convState;}
function shownConversation(){const list=convList();return list?(S.conv?list.find(c=>c.id===S.conv):list.find(c=>c.first))||null:null;}
const convArg=()=>convsOn()&&S.conv?{conversation_id:S.conv}:{};
// Its runs post in its first conversation, so only that one draws them.
function chatPosts(){return postsShown()&&!S.conv;}
async function loadConversations(){
 if(!convsOn()||!usable())return;
 const pip=S.selected,token=scope(),sequence=++convState.seq;
 try{const list=conversationsPage(await send('list_pip_conversations',{pip_id:pip,archived:true}),pip);
  if(token!==scope()||sequence!==convState.seq||S.selected!==pip)return;
  convState.pip=pip;convState.list=list;
  // The one shown was archived or is gone (another window did it): the chat goes back to its first.
  if(S.conv&&!list.some(c=>c.id===S.conv&&!c.archived)){showConversation('');return;}
  render();maybeMarkRead();
 }catch{if(token===scope()&&sequence===convState.seq&&convState.pip!==pip){convState.pip=pip;convState.list=null;render();}}
}
// The conversation leaving the screen keeps its draft, what waits to go, its messages and its place.
function stashConversation(){
 const pip=S.selected;if(!pip)return;
 rememberMarks(pip);
 const log=document.querySelector('.conversation-log');
 const scroll=log&&S.messagesLoaded?{top:log.scrollTop,end:log.scrollHeight-log.scrollTop-log.clientHeight<AT_BOTTOM_PX}:null;
 convStash.set(convKey(pip,S.conv),{draft:draft.chatText,kept:convMaps().map(map=>map.get(pip)),scroll,messages:S.messages,cursor:S.messageCursor,loaded:S.messagesLoaded,omitted:S.omitted,continuity:S.continuity});
 if(draft.chatText)convDrafts.set(convKey(pip,S.conv),draft.chatText);else convDrafts.delete(convKey(pip,S.conv));
}
function restoreConversation(){
 const pip=S.selected,key=convKey(pip,S.conv),kept=convStash.get(key);convStash.delete(key);
 messageSeq++;streamSeq++;streamLoading=false;chatContextSeq++;window.clearTimeout(waitingLook);waitingLook=0;waitingLooks=0;
 S.stream=null;S.chatActiveRun=null;S.chatWaiting=[];S.routineNotes=[];S.fallbackOn=null;S.messagesError='';S.messagesLoading=false;S.error='';S.chatContext=null;S.composerPanel='';
 S.messages=kept?.messages||[];S.messageCursor=kept?.cursor||null;S.messagesLoaded=!!kept?.loaded;S.omitted=kept?.omitted||0;S.continuity=kept?.continuity||null;
 convMaps().forEach((map,i)=>{const value=kept?.kept[i];if(value===undefined)map.delete(pip);else map.set(pip,value);});
 draft.chatText=kept?kept.draft:convDrafts.get(key)||'';convDrafts.delete(key);
 if(draft.chatText)chatDrafts.set(pip,draft.chatText);else chatDrafts.delete(pip);
 chatHistory?.reset();boxPip='';
 convScroll=kept?.scroll&&!kept.scroll.end?{pip,conv:S.conv,top:kept.scroll.top}:null;
}
/** Show one of its conversations ('' or its first one's id: the first). */
function showConversation(id,{focus=false}={}){
 const pip=S.selected,list=convList(),ui=convUi();if(!pip)return;
 const next=!id||list?.find(c=>c.id===id)?.first?'':id;
 Object.assign(ui,{menu:false,more:'',renaming:'',newStep:false,error:''});
 if(next!==S.conv){
  stashConversation();
  if(next)convShown.set(pip,next);else convShown.delete(pip);
  restoreConversation();rememberView();
 }
 render();void loadMessages();
 if(focus)$('chatText')?.focus({preventScroll:true});
}
// A message that went (or didn't) after its conversation left the screen: its own kept things are settled, not the shown one's.
function settleStashedSend(pip,conv,pending,text,failed){
 const kept=convStash.get(convKey(pip,conv));if(!kept)return;
 const [drafts,marks,,images,files,requests,replies]=[0,1,2,3,4,5,6];
 if(failed){if(!String(kept.draft||'').trim()){kept.draft=text;kept.kept[drafts]=text;if(pending.parts)kept.kept[marks]={text,parts:pending.parts};if(pending.reply&&!kept.kept[replies])kept.kept[replies]=pending.reply;convDrafts.set(convKey(pip,conv),text);}return;}
 if(kept.kept[requests]?.key===pending.key)kept.kept[requests]=undefined;
 if(String(kept.draft||'').trim()===text){kept.draft='';kept.kept[drafts]=undefined;kept.kept[marks]=undefined;convDrafts.delete(convKey(pip,conv));}
 if(pending.images?.length)kept.kept[images]=undefined;
 if(pending.files?.length)kept.kept[files]=undefined;
}
// A conversation with no name yet takes its first message's opening words (the first one stays "Chat").
function nameFromFirstMessage(pip,conv,text){
 const row=convList()?.find(c=>c.id===conv);if(!conv||!row||row.first||row.title||convTitling.has(conv))return;
 const line=String(text||'').split('\n').map(part=>part.replace(/\s+/g,' ').trim()).find(Boolean)||'';if(!line||line.startsWith('/'))return;
 const title=line.length>48?line.slice(0,47).replace(/\s+\S*$/,'')+'…':line;
 convTitling.add(conv);
 void send('rename_pip_conversation',{pip_id:pip,conversation_id:conv,title}).then(()=>{if(S.selected===pip)void loadConversations();}).catch(()=>{convTitling.delete(conv);});
}
function pipComputers(){const value=computerState.pip===S.selected?computerState.value:null;return value?.granted&&Number.isSafeInteger(value.computers)?{have:value.computers,limit:Number.isSafeInteger(value.computers_limit)?value.computers_limit:3}:null;}
function focusConv(selector){const place=convPlace();const node=document.querySelector(`#conv-${place} ${selector}`)||document.querySelector(`#conv-${place} .conv-row.is-selected`)||document.querySelector(`#conv-${place} .dgc-menu-row`);node?.focus({preventScroll:true});}
// Where the list is right now: the column when it is on screen (a wide chat), else the menu under the name.
function convPlace(){const column=$('conv-column');return column&&!convState.collapsed&&column.getClientRects().length?'column':'menu';}
function openConvMenu(){
 const ui=convUi();if(!convList())return;
 if(convPlace()==='column'){focusConv('.conv-row.is-selected');return;}
 ui.menu=!ui.menu;ui.more='';ui.renaming='';ui.newStep=false;ui.error='';render();
 if(ui.menu){focusConv('.conv-row.is-selected');void loadConversations();}
}
function closeConvMenu(){const ui=convUi();if(!ui.menu&&!ui.more&&!ui.renaming&&!ui.newStep)return;Object.assign(ui,{menu:false,more:'',renaming:'',newStep:false,error:''});render();}
// Whether it has a computer is read as its chat opens; a click before that answer waits for it (2 s at most).
async function computerKnown(){
 const pip=S.selected;if(S.apiVersion<42||!personalPip()||archived())return;
 for(let i=0;i<40&&!disposed&&S.selected===pip&&!(computerState.pip===pip&&(computerState.value||computerState.error));i++){
  if(computerState.pip!==pip||!computerState.loading)void loadComputer();
  await new Promise(done=>window.setTimeout(done,50));}
}
async function beginNewConversation(){
 const ui=convUi(),pip=S.selected;
 await computerKnown();if(S.selected!==pip||ui!==convUi())return;
 // With a computer of its own, it asks which the new conversation's work should use (the user's call, 10 Nov).
 if(personalPip()&&!archived()&&pipComputers()){ui.newStep=true;ui.newChoice='use';ui.more='';ui.renaming='';ui.error='';render();focusConv('input[name=convComputer]:checked');return;}
 void startConversation(false);
}
async function startConversation(add){
 const ui=convUi(),pip=S.selected,token=scope();if(ui.busy||!usable())return;
 ui.busy=true;ui.error='';render();
 try{
  if(add){const result=await send('add_pip_computer',{pip_id:pip});if(token!==scope())return;
   computerAdded(pip,result);if(typeof result?.name==='string'&&result.name)S.notice=`Added ${result.name}.`;}
  const made=conversation((await send('create_pip_conversation',{pip_id:pip})).conversation,pip);if(token!==scope())return;
  if(convList())convState.list=[made,...convState.list.filter(c=>c.id!==made.id)];
  ui.busy=false;showConversation(made.id,{focus:true});void loadConversations();
 }catch(error){if(token===scope()){ui.error=errorText(error);}}
 finally{if(token===scope()&&ui.busy){ui.busy=false;render();}}
}
async function convCall(command,args,after){
 const ui=convUi(),pip=S.selected,token=scope();if(ui.busy||!usable())return;
 ui.busy=true;ui.error='';render();
 try{const made=conversation((await send(command,{pip_id:pip,...args})).conversation,pip);if(token!==scope())return;
  if(convList())convState.list=convState.list.map(c=>c.id===made.id?{...c,...made,unread:c.unread,replying:c.replying}:c);
  ui.busy=false;after?.(made);render();void loadConversations();
 }catch(error){if(token===scope())ui.error=errorText(error);}
 finally{if(token===scope()&&ui.busy){ui.busy=false;render();}}
}
function convListMarkup(place){
 const ui=convUi(),list=convList();if(!list)return '';
 const computers=pipComputers();
 return conversationsMarkup({esc,conversations:list,shown:S.conv,place,more:ui.more,renaming:ui.renaming,renameText:ui.renameText,archivedOpen:ui.archivedOpen,busy:ui.busy||!usable(),error:ui.newStep?'':ui.error,
  newStep:ui.newStep&&computers?newConversationMarkup({esc,computers:computers.have,limit:computers.limit,choice:ui.newChoice,busy:ui.busy,error:ui.error}):''});
}
// The Pip's name in its chat's top bar: with conversations, a button that opens them.
// The thread selector, in the middle of a Pip's chat header (his call of 14 Nov): the conversation shown, by its name,
// with the chevron that opens the list. The Pip's face and name stay at the left whatever is shown here, so nothing in
// the header moves when the thread changes. A long name ends in "…" (the stylesheet caps its width).
// Under 560 px the stylesheet draws the chevron alone, right beside the Pip's name (his call of 15 Nov: the name never
// goes, the selector gives way); its label and tooltip still say the conversation shown.
function convThreadMarkup(p){
 const list=convList();if(!list)return '';
 const ui=convUi(),shown=shownConversation(),title=shown?conversationTitle(shown):'Chat';
 const unread=list.some(c=>!c.archived&&c.unread&&c!==shown);
 return `<div class="pip-thread"><button type="button" id="pip-convs" class="pip-convs" aria-haspopup="menu" aria-expanded="${ui.menu}" aria-controls="conv-menu" aria-label="${esc(`${title}: conversations with ${p.name}`)}" title="${esc(`${title} · conversations with ${p.name}`)}"><span class="pip-conv-title">${esc(title)}</span>${unread?'<span class="conv-mark unread" aria-hidden="true"></span>':''}<svg class="pip-convs-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>${unread?'<span class="sr-only">, something new in another conversation</span>':''}</button></div>`;
}
/** Whether this Pip has more than one conversation to choose from (or shows one that is not its first). */
function convSeveral(){const list=convList();return !!list&&(list.filter(c=>!c.archived).length>1||!!S.conv);}
function convMenuMarkup(){
 const ui=convUi();if(!ui.menu||!convList())return '';
 return `<div id="conv-menu" class="conv-menu conv-list dgc-menu" role="menu" aria-label="${esc(`Conversations with ${S.pip.name}`)}">${convListMarkup('menu')}</div>`;
}
// Beside a wide chat: the same list as a column (shown by the stylesheet from 900 px; it can be folded away).
function convColumnMarkup(){
 if(!convList()||!S.pip||S.tab!=='chat')return '';
 if(convState.collapsed)return `<nav id="conv-column" class="conv-column collapsed" aria-label="${esc(`Conversations with ${S.pip.name}`)}"><button type="button" id="conv-column-show" class="topbar-icon conv-fold" aria-label="Show conversations" title="Show conversations" aria-expanded="false">${CONV_FOLD}</button></nav>`;
 return `<nav id="conv-column" class="conv-column conv-list dgc-menu" aria-label="${esc(`Conversations with ${S.pip.name}`)}"><div class="conv-column-head"><h2>${esc(S.pip.name)}</h2><button type="button" id="conv-column-hide" class="topbar-icon conv-fold" aria-label="Hide conversations" title="Hide conversations" aria-expanded="true">${CONV_FOLD}</button></div><div class="conv-column-list">${convListMarkup('column')}</div></nav>`;
}
const CONV_FOLD='<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M6 2.5v11"/></svg>';
document.addEventListener('click',event=>{
 const target=event.target;if(!target?.closest||!convsOn())return;
 const ui=convUi(),inside=target.closest('#conv-menu,#conv-column,#pip-convs');
 if(!inside){if(ui.menu||ui.more||ui.renaming||ui.newStep)closeConvMenu();return;}
 if(target.closest('#pip-convs')){openConvMenu();return;}
 if(target.closest('#conv-column-hide,#conv-column-show')){convState.collapsed=!convState.collapsed;Object.assign(ui,{menu:false,more:'',renaming:'',newStep:false});rememberView();render();(convState.collapsed?$('conv-column-show'):$('conv-column-hide'))?.focus({preventScroll:true});return;}
 const place=target.closest('#conv-column')?'column':'menu',within=selector=>document.querySelector(`#conv-${place} ${selector}`);
 if(target.closest('[data-conv-new]')){void beginNewConversation();return;}
 if(target.closest('[data-conv-new-cancel]')){ui.newStep=false;ui.error='';render();within('[data-conv-new]')?.focus({preventScroll:true});return;}
 const more=target.closest('[data-conv-more]')?.dataset.convMore;
 if(more){ui.more=ui.more===more?'':more;ui.renaming='';render();if(ui.more)within('[data-conv-rename]')?.focus({preventScroll:true});return;}
 const rename=target.closest('[data-conv-rename]')?.dataset.convRename;
 if(rename){const row=convList()?.find(c=>c.id===rename);ui.renaming=rename;ui.renameText=row?.title||'';ui.more='';render();const box=within('[data-conv-rename-input]');box?.focus({preventScroll:true});box?.select?.();return;}
 const archive=target.closest('[data-conv-archive]')?.dataset.convArchive;
 if(archive){ui.more='';void convCall('archive_pip_conversation',{conversation_id:archive,archived:true},()=>{S.notice='Archived. It’s under Archived, with Restore.';if(S.conv===archive)showConversation('');else within('.conv-row.is-selected')?.focus({preventScroll:true});});return;}
 const restore=target.closest('[data-conv-restore]')?.dataset.convRestore;
 if(restore){void convCall('archive_pip_conversation',{conversation_id:restore,archived:false},()=>{if(!convList()?.some(c=>c.archived))ui.archivedOpen=false;queueMicrotask(()=>focusConv(`[data-conv="${restore}"]`));});return;}
 if(target.closest('[data-conv-archived]')){ui.archivedOpen=!ui.archivedOpen;render();return;}
 const chosen=target.closest('[data-conv]')?.dataset.conv;
 if(chosen){showConversation(chosen,{focus:true});return;}
});
document.addEventListener('submit',event=>{
 if(event.target?.dataset?.convNewForm!==undefined){event.preventDefault();const ui=convUi();void startConversation(ui.newChoice==='add');return;}
 const id=event.target?.dataset?.convRenameForm;if(!id)return;event.preventDefault();
 const ui=convUi(),title=String(event.target.querySelector('[data-conv-rename-input]')?.value||'').replace(/\s+/g,' ').trim().slice(0,CONVERSATION_TITLE_MAX);
 const place=event.target.closest('#conv-column')?'column':'menu';
 void convCall('rename_pip_conversation',{conversation_id:id,title},()=>{ui.renaming='';ui.renameText='';queueMicrotask(()=>document.querySelector(`#conv-${place} [data-conv="${id}"]`)?.focus({preventScroll:true}));});
});
document.addEventListener('input',event=>{if(event.target?.dataset?.convRenameInput!==undefined)convUi().renameText=event.target.value;});
document.addEventListener('change',event=>{
 if(event.target?.name==='convComputer'&&event.target.checked){convUi().newChoice=event.target.value==='add'?'add':'use';return;}
 const routine=event.target?.dataset?.routineConv;
 if(routine){const id=event.target.value,first=convList()?.find(c=>c.id===id)?.first;
  void routineCall('update_pip_routine',{routine_id:routine,changes:{conversation_id:first?null:id}},routine,`It posts in ${conversationTitle(convList()?.find(c=>c.id===id))} now.`);}
});
// The keys the list answers (media/shared/menu.js): Down and Up between rows, Home and End, Right to a row's "…",
// Escape one step back (a name being typed, a row's choices, the computer question), then out to the Pip's name.
function convKeydown(event){
 if(!convsOn())return false;
 const target=event.target,ui=convUi();
 if(target.id==='pip-convs'&&event.key==='ArrowDown'&&convPlace()==='menu'){event.preventDefault();if(ui.menu)focusConv('.conv-row.is-selected');else openConvMenu();return true;}
 if(target.id==='pip-convs'&&event.key==='Escape'&&ui.menu){event.preventDefault();event.stopPropagation();closeConvMenu();return true;}
 const holder=target.closest?.('#conv-menu,#conv-column');if(!holder)return false;
 const menu=holder.id==='conv-menu';
 if(event.key==='Escape'){
  if(ui.renaming||ui.more||ui.newStep){event.preventDefault();event.stopPropagation();const back=ui.renaming||ui.more;Object.assign(ui,{renaming:'',more:'',newStep:false,error:''});render();
   (back?holder.querySelector(`[data-conv="${back}"]`):holder.querySelector('[data-conv-new]'))?.focus({preventScroll:true});return true;}
  if(!menu)return false;
 }
 if(target.matches?.('input,select,textarea')&&event.key!=='Escape'&&event.key!=='Tab')return false;
 if(!menu&&!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return false;
 return !!globalThis.DgcMenu?.handle(holder,event,{rows:'.dgc-menu-row',close:()=>{if(menu)closeConvMenu();},trigger:()=>$('pip-convs')});
}
async function addComputer(){
 const pip=S.selected,token=scope();if(S.busy||!usable()||!pip)return;
 S.busy=true;S.error='';render();
 try{const result=await send('add_pip_computer',{pip_id:pip});if(token!==scope())return;
  computerAdded(pip,result);
  // Which one was added, by its name (Pips API 86).
  S.notice=`${typeof result?.name==='string'&&result.name?`Added ${result.name}. `:''}${S.pip?.name||'It'} has ${result?.computers} computers now. Its conversations share them.`;}
 catch(error){if(token===scope())S.error=errorText(error);}
 finally{if(token===scope()){S.busy=false;render();}}
}
// What add_pip_computer answered: how many it has now and, from Pips API 86, each one's name.
function computerAdded(pip,result){
 if(computerState.pip!==pip||!computerState.value||!Number.isSafeInteger(result?.computers))return;
 computerState.value={...computerState.value,computers:result.computers,...(Number.isSafeInteger(result.limit)?{computers_limit:result.limit}:{})};
 computerNamed(pip,result.names);
}
// Names from a rename or an add (no states with them): each keeps the state it was last seen in.
function computerNamed(pip,names){
 if(computerState.pip!==pip||!computerState.value||!computerNames(names))return;
 const was=computerState.value.names||[];
 computerState.value={...computerState.value,names:names.map(n=>{const old=was.find(o=>o.number===n.number);return {...n,state:old?.state||'closed',...(old?.doing?{doing:old.doing}:{})};})};
}
// Its computers by name (Pips API 86), the first first; null on an older DGC, or before it has a computer.
function pipComputerNames(){
 const value=computerState.pip===S.selected?computerState.value:null;
 return S.apiVersion>=86&&!remoteHost&&value?.granted&&Array.isArray(value.names)&&value.names.length?value.names:null;
}
// With more than one, the computer icon opens a menu to choose which (the user's call, 12 Nov): each one's name, a dot
// for its state, Rename in the row, and Add another. While it is open its states are read again every few seconds.
const compUi={pip:'',menu:false,renaming:0,place:'',renameText:'',error:'',busy:false};
let compPoll=null;
function computerUi(){if(compUi.pip!==S.selected)Object.assign(compUi,{pip:S.selected,menu:false,renaming:0,place:'',renameText:'',error:'',busy:false});return compUi;}
function severalComputers(){const names=pipComputerNames();return !!names&&names.length>1&&personalPip()&&!archived();}
function computerPolling(){
 const on=computerUi().menu&&!disposed;
 if(on&&compPoll===null)compPoll=window.setInterval(()=>{if(!computerUi().menu||disposed||!$('computer-menu')){computerPolling();return;}if(!document.hidden)void refreshComputer();},3000);
 if(!on&&compPoll!==null){window.clearInterval(compPoll);compPoll=null;}
}
function openComputerMenu(){
 const ui=computerUi();if(!severalComputers())return;
 Object.assign(ui,{menu:true,renaming:0,place:'',renameText:'',error:''});render();computerPolling();
 ($('computer-menu')?.querySelector('.computer-row:not(:disabled)'))?.focus({preventScroll:true});
 void refreshComputer();
}
function closeComputerMenu(){
 const ui=computerUi();if(!ui.menu)return;
 Object.assign(ui,{menu:false,...(ui.place==='menu'?{renaming:0,place:'',renameText:'',error:''}:{})});computerPolling();render();
}
function computerMenuMarkup(){
 const ui=computerUi(),names=pipComputerNames();if(!ui.menu||!severalComputers())return '';
 const menu=ui.place==='menu';
 return `<div id="computer-menu" class="computer-menu conv-list dgc-menu" role="menu" aria-label="${esc(`${S.pip.name}'s computers`)}">${computersMenuMarkup({esc,names,limit:pipComputers()?.limit||names.length,
  renaming:menu?ui.renaming:0,renameText:ui.renameText,busy:ui.busy||S.busy||!usable(),error:menu||!ui.renaming?ui.error:''})}</div>`;
}
// The icon itself: one small dot at its corner for the most urgent state among its computers (needs you, then working).
function computerIconMarkup(){
 const names=pipComputerNames(),several=severalComputers(),urgent=urgentComputerState(names),ui=computerUi();
 const label=names?computerIconWords(names):'Computer';
 return `<button type="button" id="pip-computer-open" class="topbar-icon computer-icon" aria-label="${esc(label)}" title="${several?'Its computers':computerState.pip===S.selected&&computerState.value?.granted?'Open its computer':'Its computer'}"`
  +`${several?` aria-haspopup="menu" aria-expanded="${ui.menu}" aria-controls="computer-menu"`:''}${S.busy||!usable()||archived()?' disabled':''}>${simpleIcon('computer')}${urgent?`<span class="computer-corner" data-state="${urgent}" aria-hidden="true"></span>`:''}</button>`;
}
function beginComputerRename(number,place){
 const ui=computerUi(),row=pipComputerNames()?.find(n=>n.number===number);if(!row||ui.busy)return;
 Object.assign(ui,{renaming:number,place,renameText:row.name,error:''});render();
 const box=$(place==='menu'?'computer-rename-input':'computer-name-input');box?.focus({preventScroll:true});box?.select?.();
}
function endComputerRename(){
 const ui=computerUi(),{renaming,place}=ui;if(!renaming)return;
 Object.assign(ui,{renaming:0,place:'',renameText:'',error:''});render();
 $(place==='menu'?`computer-row-${renaming}`:`computer-name-rename-${renaming}`)?.focus({preventScroll:true});
}
async function saveComputerName(number,text){
 const ui=computerUi(),pip=S.selected,token=scope();if(ui.busy||!usable()||!pip)return;
 const name=cleanComputerName(text),problem=computerNameProblem(name);
 if(problem){ui.error=problem;render();return;}
 ui.busy=true;ui.error='';render();
 try{
  const result=await send('rename_pip_computer',{pip_id:pip,number,name});if(token!==scope())return;
  computerNamed(pip,result?.names);ui.busy=false;endComputerRename();void refreshComputer();
 }catch(error){if(token===scope()){ui.error=errorText(error);}}
 finally{if(token===scope()&&ui.busy){ui.busy=false;render();const box=$(ui.place==='menu'?'computer-rename-input':'computer-name-input');box?.focus({preventScroll:true});}}
}
document.addEventListener('click',event=>{
 const target=event.target;if(!target?.closest)return;
 const ui=computerUi();
 const page=target.closest('[data-computer-name-rename]')?.dataset.computerNameRename;
 if(page){beginComputerRename(Number(page),'page');return;}
 if(target.closest('[data-computer-name-cancel]')){endComputerRename();return;}
 if(!target.closest('#computer-menu,#pip-computer-open')){if(ui.menu)closeComputerMenu();return;}
 const menu=target.closest('#computer-menu');if(!menu)return;
 const rename=target.closest('[data-computer-rename]')?.dataset.computerRename;
 if(rename){beginComputerRename(Number(rename),'menu');return;}
 if(target.closest('[data-computer-add]')){void addComputer().then(()=>{($('computer-add')||[...document.querySelectorAll('#computer-menu .computer-row')].at(-1))?.focus({preventScroll:true});});return;}
 const chosen=target.closest('[data-computer]')?.dataset.computer;
 if(chosen){closeComputerMenu();$('pip-computer-open')?.focus({preventScroll:true});void openComputerView(Number(chosen));}
});
document.addEventListener('submit',event=>{
 const number=event.target?.dataset?.computerRenameForm;if(!number)return;event.preventDefault();
 void saveComputerName(Number(number),event.target.querySelector('[data-computer-rename-input]')?.value||'');
});
document.addEventListener('input',event=>{if(event.target?.dataset?.computerRenameInput!==undefined)computerUi().renameText=event.target.value;});
// The keys (media/shared/menu.js): Down on the icon opens it; Down and Up between rows, Right to a row's Rename, Enter
// opens; Escape leaves a name being typed, then closes the menu and goes back to the icon.
function computerKeydown(event){
 const target=event.target,ui=computerUi();
 if(target?.dataset?.computerRenameInput!==undefined&&event.key==='Escape'){event.preventDefault();event.stopPropagation();endComputerRename();return true;}
 if(target?.id==='pip-computer-open'&&severalComputers()){
  if(event.key==='ArrowDown'){event.preventDefault();if(ui.menu)$('computer-menu')?.querySelector('.computer-row')?.focus({preventScroll:true});else openComputerMenu();return true;}
  if(event.key==='Escape'&&ui.menu){event.preventDefault();event.stopPropagation();closeComputerMenu();return true;}
  return false;
 }
 const holder=target?.closest?.('#computer-menu');if(!holder)return false;
 if(target.matches?.('input,select,textarea')&&event.key!=='Tab')return false;
 return !!globalThis.DgcMenu?.handle(holder,event,{rows:'.dgc-menu-row',close:()=>closeComputerMenu(),trigger:()=>$('pip-computer-open')});
}
// Beside its name on its chat: its folder (the whole path is the tooltip), or its fix while one runs.
function folderWhereMarkup(p){
 const live=flowLive(),row=pipFolderRow(p),name=pipFolderName(p);
 if(live){const since=Date.parse(live.started_at);return `<small class="pip-where" data-fixing="1">Fixing${Number.isFinite(since)?` · ${esc(took(Date.now()-since,true))}`:''}</small>`;}
 return name?`<small class="pip-where" title="${esc(row?.folder||name)}">${esc(name)}</small>`:'';
}
// Run now, in the header's menu (where a Personal Pip's header has no such thing): what History's button runs.
function runNowMenuRow(){
 const action=runAction();if(!action||activeOwnRun())return '';
 const blocked=runBlocked();
 return `<button type="button" id="pip-run-now" title="${esc(blocked||action.title)}"${blocked?' disabled':''}>Run now</button><hr>`;
}
function simplePipHeader(){
 const p=S.pip,type=pipType(p,S.types)||characterType(p.pip_type),pose=presentation(p,S.runs,usable(),S.runner),onChat=S.tab==='chat';
 // A Project Pip's menu is every section its old page had; a Personal Pip's, the ones it uses.
 // One Pips: every Pip has the Personal Pip's header. A Pip with a folder keeps every section it has in its menu, with
 // Run now there, and says its folder beside its name.
 const project=!pagePip(),folderPip=!personalPip()&&!project,every=project||folderPip?pipSections():null;
 const sections=(project||folderPip?every:[['chat','Chat'],['runs',historyName('Results')],['job','Settings'],...(S.apiVersion>=14&&!(S.apiVersion>=44&&personalPip())?[['memory','Memory']]:[]),['revisions','Changes'],...(S.apiVersion>=13?[['notifications','Notifications']]:[])]).filter(([key])=>key!==S.tab);
 if(S.apiVersion>=43&&!remoteHost&&mayHaveBox()&&screenSetup.pip!==S.selected&&!screenSetup.loading)void loadDesktopStatus();
 const computer=!(S.apiVersion>=42&&(personalPip()||folderBox()))?'':settingUpComputer()
  ?`<span class="topbar-setup" role="status" title="Getting its computer ready. This happens once."><span class="topbar-spinner" aria-hidden="true"></span>Setting up your Pip…</span>`
  :computerIconMarkup();
 if(pageView()){
  // Its page (Grok's bot settings): back, its name, then Share and a small menu.
  const sub=['instructions','character'].includes(S.pipPage),share=S.apiVersion>=41&&['scout','lens','rook','lock','quill'].includes(p.pip_type)&&!archived();
  return `<header class="pip-topbar"><button type="button" id="${sub?'pip-page-back':'simple-to-chat'}" class="topbar-icon" aria-label="${sub?'Back':'Back to the chat'}" title="${sub?'Back':'Back to the chat'}">${simpleIcon('back')}</button><div class="pip-pill${pipOff(p)?' is-off':''}">${pipAvatar(p,pose.state,`pill-${p.id}`,type)}<span>${esc(p.name)}</span><small>${sub?(S.pipPage==='character'?'Face':'Instructions'):'Settings'}${pipOff(p)?' · Off':''}</small></div><div class="topbar-actions">${pipSwitchMarkup(p)}${share?`<button type="button" class="topbar-icon" data-pip-share aria-label="Share as template" title="Share as template"${S.busy||!usable()?' disabled':''}>${simpleIcon('share')}</button>`:''}<details class="pip-menu" data-details="pip-menu"><summary class="topbar-icon" aria-label="More" title="More">${simpleIcon('more')}</summary><div class="tabs-menu dgc-menu dgc-menu-rows">${pipPageMenu()}</div></details></div></header>`;
 }
 const actions=`<div class="topbar-actions">${pipSwitchMarkup(p)}${project||folderPip&&activeOwnRun()?runNowMarkup():''}${computer}<details class="pip-menu" data-details="pip-menu"><summary class="topbar-icon" aria-label="More" title="More">${simpleIcon('more')}</summary><div class="tabs-menu dgc-menu dgc-menu-rows">${folderPip?runNowMenuRow():''}${sections.map(([key,label])=>`<button type="button" data-tab="${key}">${label}</button>`).join('')}</div></details></div>`;
 // Its chat: back, its face and name at the left, fixed; the thread selector in the middle, always centred; the switch,
 // its computer and the menu at the right (live round 1, 14 Nov). What a Project Pip last did, or its folder, follows
 // its name where there is room.
 if(onChat){
  // (Pointed at, its face says who it is: a Project Pip's character and role as before, any other Pip's name. Its
  // name is always drawn, his call of 15 Nov; where it ends in "…" the name itself says all of it when pointed at.)
  const thread=convThreadMarkup(p),pillTitle=project&&pipType(p,S.types)?`${type.name} · ${type.role}`:p.name;
  return `<header class="pip-topbar pip-topbar-chat${thread?(convSeveral()?' has-threads':' one-thread'):''}"><button type="button" id="simple-back" class="topbar-icon" aria-label="Your Pips" title="Your Pips">${simpleIcon('back')}</button><div class="pip-pill${pipOff(p)?' is-off':''}" title="${esc(pillTitle)}">${pipAvatar(p,pose.state,`pill-${p.id}`,type)}<span class="pip-name" title="${esc(p.name)}">${esc(p.name)}</span>${project?`<small class="pip-status">${lastRunLink(p,pose.label)}</small>`:folderPip?folderWhereMarkup(p):''}</div>${thread}${actions}${convMenuMarkup()}${computerMenuMarkup()}</header>`;
 }
 return `<header class="pip-topbar"><button type="button" id="simple-to-chat" class="topbar-icon" aria-label="Back to the chat" title="Back to the chat">${simpleIcon('back')}</button><div class="pip-pill${pipOff(p)?' is-off':''}"${project&&pipType(p,S.types)?` title="${esc(`${type.name} · ${type.role}`)}"`:''}>${pipAvatar(p,pose.state,`pill-${p.id}`,type)}<span>${esc(p.name)}</span><small>${esc(project||folderPip?(every.find(([key])=>key===S.tab)||[])[1]||'':sections.length&&{runs:historyName('Results'),job:'Settings',memory:'Memory',revisions:'Versions',notifications:'Notifications',schedule:'Schedule',handoffs:'Handoffs',context:'Context'}[S.tab]||'')}</small></div>${actions}${computerMenuMarkup()}</header>`;
}
function simpleMarkup(){
 // The header row every page of the side bar wears (media/shared/pagehead.js): "Pips" at the left, its status dot beside it, ⋯ (the Controls) at the right, the line under it.
 const bar=`${window.DgcPageHead.html({title:'Pips',level:1,cls:'simple-bar',rest:runnerMarkup(true)})}${scopeTabsMarkup()}`;
 const notes=`${S.error?`<div class="simple-note">${errorMarkup(S.error)}</div>`:''}${S.notice?`<p class="notice simple-note" role="status">${esc(S.notice)}</p>`:''}${undoRejectMarkup()}`;
 if(pipsSettings.view&&(!S.selected||S.overview)&&!S.create)return `${pipsSettingsMarkup()}${notes}`;
 // Needs attention's View all: a page of its own. A new Pip rejected there says so in its own place, not in a line above.
 if(attentionAllShown())return attentionAllPageMarkup(`${S.error?`<div class="simple-note">${errorMarkup(S.error)}</div>`:''}${S.notice?`<p class="notice simple-note" role="status">${esc(S.notice)}</p>`:''}`);
 // (With the Project Folder dropdown that page is the Project tab's list: a Pip that is open shows over it.)
 if(S.projectEmpty&&scopeTabs()&&(!foldersOn()||(!S.selected||S.overview)&&!S.create))return `${bar}${notes}${projectEmptyMarkup()}`;
 const project=projectHome(),back=(id,label)=>`<button type="button" id="${id}" class="topbar-icon" aria-label="${esc(label)}" title="${esc(label)}">${simpleIcon('back')}</button>`;
 // A project's describe-the-job page (DGC prepares a setup card from your words, or a common job, or a shared Pip's file),
 // and "Change in chat" from a Project Pip's Settings: the old page's, under the same top bar.
 if(project&&S.create)return `<header class="pip-topbar">${back('create-back',setupEditing&&S.pip?`Back to ${S.pip.name}`:'Your Pips')}<div class="pip-pill settings-pill"><span>${setupEditing&&S.pip?`Change ${esc(S.pip.name)}`:'New Pip'}</span></div><span></span></header>${notes}<div class="simple-content" data-view="create">${createMarkup()}</div>`;
 // The project's context and notifications, opened from its home's menu (the old side bar's two buttons).
 if(project&&!S.selected&&!S.overview&&['context','notifications'].includes(S.tab))return `<header class="pip-topbar">${back('workspace-back','Your Pips')}<div class="pip-pill settings-pill"><span>${S.tab==='context'?'Workspace context':'Notifications'}</span></div><span></span></header><div class="simple-content" data-view="${esc(S.tab)}">${notes}${S.tab==='context'?contextMarkup():notificationsMarkup()}</div>`;
 // One Pips: the one list, whatever is loaded underneath.
 if(onePips()&&(!S.selected||S.overview)&&!S.create)return `${bar}${notes}<div class="simple-content pips-one">${oneHomeMarkup()}</div>`;
 if(!S.selected||S.overview||S.create)return `${bar}${notes}<div class="simple-content"${scopePanelAttrs()}>${S.switching?(project?folderLineMarkup():''):simpleHomeMarkup()}</div>`;
 if(!S.pip)return `${bar}${loadingMark()}`;
 return `${convColumnMarkup()}${simplePipHeader()}${pipSetupNotes()}<div class="simple-content${S.tab==='chat'?' chat':''}" data-view="${esc(S.tab)}">${S.tab==='chat'?chatMarkup():`${notes}${waitingMarkup()}${simpleTabContent()}`}</div>`;
}
// A page with a back arrow is open: the side bar gives it the room its dock and its tab bar take (media/main.js,
// onInsidePip). That is every page inside one Pip (its chat, its Settings with Instructions and Face, History, Changes,
// Notifications, Memory and the rest of its menu, "Change in chat"), and, from 12 Nov, every other page of this view
// that has one: Pips settings with its tabs, Needs attention's View all, a project's New Pip page and its Workspace
// context and Notifications. One rule: the page's top bar begins with a back arrow, and that is what is looked for, so
// a page added later follows it too. The list of Pips has none and keeps both. Said on every draw, so the page is
// never a draw behind.
function pageBack(){return shell.querySelector('.pip-topbar > button.topbar-icon:first-child');}
function tellInsidePip(){if(typeof options.onInsidePip!=='function')return;try{options.onInsidePip((shell.classList.contains('chat-open')&&!!$('chat-form'))||!!pageBack());}catch{}}
function render() {
  if(disposed)return;
  // A redraw replaces the slider under a pointer that is dragging it, and the drag ends where it was (final check,
  // 2026-11-07): the page's own refreshes wait until the slider is let go.
  if(effortHeld){effortRedraw=true;return;}
  settleProjectTab();
  renderAgentMap();
  noticeFades();syncNewPipModel();
  const focus=document.activeElement; const focusId=focus?.id; const focusActivity=focus?.dataset?.chatActivity; const focusData=focus?.getAttribute?.('data-run')||focus?.getAttribute?.('data-job')||focus?.getAttribute?.('data-pip-type'); const inBox=!!chatBox&&focus===chatBox.el;const selection=focus&&typeof focus.selectionStart==='number'&&!inBox?[focus.selectionStart,focus.selectionEnd]:null;const boxAt=inBox?Mentions.selectedOffsets(chatBox.el):null;
  const focusPlace=focusMark(focus)||focusStillOwed();
  const oldLog=document.querySelector('.conversation-log'),oldScroll=oldLog?.scrollTop||0,oldHeight=oldLog?.scrollHeight||0,oldFirst=oldLog?.querySelector('[data-message]')?.dataset.message;
  const oldPipId=shell.dataset.motionPip||'',oldConv=shell.dataset.motionConv||'',oldMessageRows=[...(oldLog?.querySelectorAll('[data-message]')||[])];
  const oldMessages=new Set(oldMessageRows.map(e=>e.dataset.message));
  const oldLatest=oldMessageRows.at(-1)?.dataset.message||'';
  const oldJobs=new Map([...document.querySelectorAll('[data-job][data-state]')].map(e=>[e.dataset.job,{state:e.dataset.state,waiting:Number(e.dataset.waiting)||0}]));
  const opened=new Set([...document.querySelectorAll('details[open][data-details]')].map(e=>e.dataset.details));
  const intro=welcome(),chatView=!intro&&!S.create&&!S.overview&&!!S.pip&&S.tab==='chat';
  shell.classList.toggle('sidebar-pinned',S.sidebarPinned);
  shell.classList.toggle('chat-open',!intro&&!S.create&&!S.overview&&!!S.pip&&S.tab==='chat');
  shell.classList.toggle('simple-pips',!intro&&simpleMode());
  const header=(embedded?`<header class="embedded-header${!intro&&scopeTabs()?' scoped':''}"><span class="workspace-name" title="${esc(S.workspace?.name||'Current workspace')}">${esc(S.workspace?.name||'Pips')}</span>${runnerMarkup()}</header>`:`<header><div class="heading"><div>${options.close?button('return-main','Back to DGC',false,'back-control'):''}<h1><span class="pips-wordmark">Pips</span></h1><p class="muted">${esc(S.workspace?.kind==='personal'?'Personal':S.workspace?.name||'Current workspace')}</p></div></div>${runnerMarkup()}</header>`)+(intro?'':scopeTabsMarkup());
  const markup=!intro&&simpleMode()?simpleMarkup():`${header}${S.error&&!chatView?`<div style="padding:0 20px">${errorMarkup(S.error)}</div>`:''}${S.notice&&!chatView?`<p class="notice" role="status">${esc(S.notice)}</p>`:''}${chatView?'':undoRejectMarkup()}${!intro&&S.overview&&!S.create&&!(S.projectEmpty&&scopeTabs())?setupsMarkup():''}${intro?`<div class="content">${intro}</div>`:S.projectEmpty&&scopeTabs()?projectEmptyMarkup():S.switching?`<div class="pips-tab-loading"${scopePanelAttrs()}></div>`:`<div class="layout ${S.overview&&!S.create?'overview':'selected'}"${scopePanelAttrs()}><aside aria-label="Workspace Pips"><div class="aside-heading">${!remoteHost?`<button type="button" id="pin-pips-sidebar" class="sidebar-toggle" aria-label="${S.sidebarPinned?'Collapse Pip sidebar':'Pin Pip sidebar open'}" title="${S.sidebarPinned?'Collapse Pip sidebar':'Pin Pip sidebar open'}" aria-pressed="${S.sidebarPinned}"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 2v12"/></svg></button>`:''}<h2>Your Pips</h2><button type="button" id="new-pip" aria-label="New Pip" title="New Pip"${S.busy||!usable()||!S.types.length?' disabled':''}><span aria-hidden="true" class="new-pip-mark">+</span><span class="new-pip-text">New</span></button></div>${S.overview&&!S.create?`<div class="pips-overview-intro${S.jobs.length?'':' welcome'}"><span class="pips-eyebrow">${S.workspace?.kind==='personal'?'A little help, day to day':'Your project, looked after'}</span><h2>A little team. A clear purpose.</h2><p>Give each Pip a job. Stay in the conversation, and review what comes back.</p></div>`:''}<div class="job-list">${S.jobs.filter(p=>S.showArchived||p.status!=='archived').map(jobMarkup).join('')||`<div class="pips-first-job"><div class="pips-welcome-cast">${S.types.filter(t=>['scout','rook','pulse'].includes(t.id)).map(t=>avatar('idle',t,`welcome-${t.id}`)).join('')}</div><h3>What should your first Pip look after?</h3><p>Describe the job to DGC. You’ll review the scope and schedule before it starts.</p>${button('create-first','Describe a job',!usable()||!S.types.length,'primary')}<small>No Pips yet · Nothing is running for this project</small></div>`}</div>${S.jobs.some(p=>p.status==='archived')?button('show-archived',S.showArchived?'Hide archived Pips':`Show archived Pips (${S.jobs.filter(p=>p.status==='archived').length})`):''}${button('workspace-context','Workspace context',!usable())}${S.apiVersion>=13?button('workspace-notifications','Notifications',!usable()):''}${!embedded&&!remoteHost?`<details><summary>Local controls</summary><p class="muted">Stop all pauses every Pip on this computer and stops what they’re doing. To undo it, resume Pips here, then resume each Pip.</p>${button('disable','Turn off Pips…',S.busy||!usable())}</details>`:''}</aside><div class="content" data-view="${esc(S.tab)}">${!S.create&&(S.selected||['context','notifications'].includes(S.tab))?button('back-pips','Back to Pips',false,'back-control'):''}${S.overview&&!S.create?'':setupsMarkup()}<nav class="tabs" aria-label="Pip sections"${S.create||!S.selected?' hidden':''}>${tabsMarkup()}</nav>${detailMarkup()}</div></div>`}`;
  if(markup===lastMarkup){syncChatBox();tellInsidePip();return;}
  lastMarkup=markup;
  const allAnchor=attentionAllAnchor();
  const previousAvatars=new Map([...document.querySelectorAll('[data-avatar-key]')].map(node=>[node.dataset.avatarKey,node]));
  avatarObserver?.disconnect();
  globalThis.DgcMcpApps?.park();          // a plugin card's live frame waits out the redraw (media/mcpApps.js)
  if(chatView&&oldLog&&oldPipId===S.selected){
    const next=owner.createElement('template');next.innerHTML=markup;
    patchChildren($('app'),next.content);
  }else $('app').innerHTML=markup;
  keepAttentionAllScroll(allAnchor);
  tellInsidePip();   // with the draw itself, so the side bar's dock and tab bar go and come in the same frame
  // The keyed chat patch above retains message nodes and their selection, and leaves the box in place. The other
  // takes it out, so it goes back with its caret where it was.
  syncChatBox();
  if(boxAt&&!S.review&&chatBox.el.isConnected&&owner.activeElement!==chatBox.el&&document.activeElement!==chatBox.el){chatBox.el.focus({preventScroll:true});chatBox.el.setSelectionRange(boxAt[0],boxAt[1]);}
  globalThis.DgcMcpApps?.fill($('app'),{sendMessage:sendCardMessage});
  drawChatQueue();
  shell.dataset.motionPip=S.selected||'';shell.dataset.motionConv=S.conv;
  for(const row of document.querySelectorAll('[data-job][data-state]')){
    const previous=oldJobs.get(row.dataset.job);
    if(previous&&previous.state!==row.dataset.state)row.classList.add('pip-motion-state');
    if(previous&&Number(row.dataset.waiting)>previous.waiting)row.classList.add('pip-motion-news');
  }
  if(oldPipId===S.selected&&oldConv===S.conv&&S.messagesLoaded&&oldMessages.size){
    const last=[...document.querySelectorAll('.conversation-log [data-message]')].at(-1);
    if(last&&!oldMessages.has(last.dataset.message)&&last.dataset.message!==oldLatest)last.classList.add('pip-motion-arrive');
  }
  reader?.sync();talkBar?.refresh();voiceBar?.refresh();
  const parts=document.querySelector('.pip-ctx-breakdown');if(parts&&S.chatContext?.breakdown&&window.DgcBreakdown)parts.replaceChildren(window.DgcBreakdown.render(S.chatContext.breakdown));
  for(const node of document.querySelectorAll('[data-avatar-key]')){const old=previousAvatars.get(node.dataset.avatarKey);if(old&&old!==node&&old.dataset.character===node.dataset.character&&old.dataset.pose===node.dataset.pose)node.replaceWith(old);}
  observeAvatars();fitChatInput();hydrateMessageImages();hydrateMessageVideos();hydratePluginLogos();
  if(typeof DgcIconActions!=='undefined')DgcIconActions.refresh(root);   // an answer the pointer or the keyboard is still on shows its pill again
  // A card Needs attention opened stays shown as the chat redraws while its drafts and apps load.
  if(cardFlash.selector&&Date.now()<cardFlash.until)for(const el of document.querySelectorAll(cardFlash.selector))el.classList.add('attention-flash');
  for(const el of document.querySelectorAll('details[data-details]')) if(opened.has(el.dataset.details)) el.open=true;
  const newLog=document.querySelector('.conversation-log'),first=newLog?.querySelector('[data-message]')?.dataset.message;
  chatFollow.drawn(newLog,newLog?$('pip-to-latest'):null,{opened:!!newLog&&(!oldLog||oldPipId!==S.selected||oldConv!==S.conv),grew:newLog&&oldLog?newLog.scrollHeight-oldHeight:0,olderAbove:!!oldFirst&&first!==oldFirst,scroll:oldLog?oldScroll:null});
  // A conversation that comes back is where it was left (unless it was at its end, where it follows on).
  if(convScroll&&newLog&&S.messagesLoaded&&convScroll.pip===S.selected&&convScroll.conv===S.conv){chatFollow.restore(convScroll.top);convScroll=null;}
  if(focusId && !S.review) { const next=$(focusId);next?.focus({preventScroll:true});if(selection&&next?.setSelectionRange) next.setSelectionRange(...selection); }
  else if(focusActivity&&!S.review)[...document.querySelectorAll('[data-chat-activity]')].find(e=>e.dataset.chatActivity===focusActivity)?.focus({preventScroll:true});
  else if(focusData && !S.review) [...document.querySelectorAll('[data-job],[data-run],[data-pip-type]')].find(e=>e.dataset.job===focusData||e.dataset.run===focusData||e.dataset.pipType===focusData)?.focus({preventScroll:true});
  if(!S.review)landFocus(focusPlace,!focusIsCallers);
  picker.restore();
}
// Where the keyboard is, kept across a redraw (found 13 Nov: Enter on a control with no id redrew it and the focus
// dropped, to nothing in the side bar and to the body in a tab). render() finds a control with an id again by its id;
// this is for the rest. `selector`: a control with no id is known by its tag and its data attributes (a card's row by
// its card, a project's Pip by its id, Undo by what it takes back), less the ones that say how it looks now. `card`:
// in Needs attention, the card it is on and where that card is in the list, for when the control itself is gone.
const FOCUS_PASSING=['state','waiting','attentionIndex'];
let focusIsCallers=false,focusOwed=null;
// A redraw whose caller says where the keyboard goes next (another card, the page of them all and back): the same
// control is still found again, but no other place is chosen here first.
function renderThenFocus(){focusIsCallers=true;try{render();}finally{focusIsCallers=false;}}
function focusMark(el){
 if(!el||el===shell||!el.closest||!$('app')?.contains(el))return null;
 const data=el.id?[]:Object.entries(el.dataset).filter(([name,value])=>!FOCUS_PASSING.includes(name)&&value.length<=200);
 const selector=data.length?el.localName+data.map(([name,value])=>`[data-${name.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}="${CSS.escape(value)}"]`).join(''):'';
 const li=el.closest('[data-attention-key]'),inList=!!el.closest('.attention-all-list');
 const card=li||el.closest('.attention-carousel,.attention-all-link,.undo-reject')?{key:li?.dataset.attentionKey||'',index:li&&inList?[...li.parentNode.children].indexOf(li):0}:null;
 return selector||card?{selector,nth:selector?[...document.querySelectorAll(selector)].indexOf(el):0,card}:null;
}
// After the redraw, and only when it left the keyboard nowhere: back on the same control; or, in Needs attention when
// that control went with its card (answered, rejected, its moment for Undo over), on the card that took its place (the
// next; after the last, the one before), then on what is left to go on from: the heading's fold, the way back from the
// page of them all, Undo for a new Pip just rejected, the tab you are on. Nothing moves a focus that is somewhere.
function landFocus(mark,elsewhere=true){
 const at=document.activeElement;focusOwed=null;
 if(!mark||at&&at!==shell&&at!==owner.body&&at.isConnected)return;
 const again=mark.selector?[...document.querySelectorAll(mark.selector)]:[],same=again[mark.nth]||again[0];
 if(same&&!same.disabled){same.focus({preventScroll:true});return;}
 if(!mark.card||!elsewhere)return;
 const rows=[...document.querySelectorAll('.attention-all-list>[data-attention-key]')],first=li=>li?.querySelector('button:not(:disabled)');
 const card=rows.length?rows.find(li=>li.dataset.attentionKey===mark.card.key)||rows[Math.min(mark.card.index,rows.length-1)]:document.querySelector('.attention-stage>[data-attention-key]');
 // Its card is there with every button off (its answer is on its way to DGC): the keyboard waits for the draw after.
 if(card&&!first(card)){focusOwed=mark;return;}
 (first(card)||$('attention-all-done')||[$('attention-toggle'),$('attention-all-back')].find(b=>b&&!b.disabled)||document.querySelector('.undo-reject button')||document.querySelector('[data-pips-tab][aria-selected="true"]'))?.focus?.({preventScroll:true});
}
// A place still owed from the draw before, while the keyboard is nowhere at all (not elsewhere in the window: the page
// around a side bar's view names the view's host as its focus only while the focus is inside the view).
function focusStillOwed(){
 const at=owner.activeElement;
 if(focusOwed&&at&&at!==owner.body)focusOwed=null;
 return focusOwed;
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
 const gmail=connectedLinks('gmail'),calendar=connectedLinks('googlecalendar'),pipName=S.pip?.name||'This Pip';
 const from=(d,links)=>({link:pickedLink(d.id,links),links,fromOpen:allowFromOpen===d.id});
 const full=d=>S.apiVersion>=43?draftDetails.get(d.id+':'+d.digest):null,open=d=>d.status==='pending'&&!d.expired&&full(d);
 const allow=(S.emailDrafts||[]).filter(open).map(d=>allowCardMarkup(full(d),{esc,...from(d,gmail),busy:allowBusy===d.id||S.busy||archived(),pipName,edit:cardEdit(d)})).join('')
  +(S.apiVersion>=35?S.calendarDrafts||[]:[]).filter(open).map(d=>calendarCardMarkup(full(d),{esc,...from(d,calendar),busy:allowBusy===d.id||S.busy||archived(),pipName,edit:cardEdit(d)})).join('');
 return allow+[...(S.emailDrafts||[]).filter(d=>!full(d)),...(S.apiVersion>=35?(S.calendarDrafts||[]).filter(d=>!full(d)):[]),...(S.apiVersion>=37?(S.connectorDrafts||[]).filter(d=>!pluginDraft(d)):[])].filter(d=>d.status==='pending'&&!d.expired).map(d=>{const label=d.id.startsWith('conndraft_')?'App action for you to check':d.id.startsWith('caldraft_')?'Calendar event for you to check':'Email for you to check';return `<div class="chat-setup-review" aria-label="${label}"><span class="chat-setup-label">${label} <small>${esc(d.subject)}</small></span><button type="button" data-email-draft="${esc(d.id)}"${S.busy?' disabled':''}>Review</button></div>`;}).join('')+(S.emailDraftError?errorMarkup(S.emailDraftError):'')+(S.calendarDraftError?errorMarkup(S.calendarDraftError):'')+(S.connectorDraftError?errorMarkup(S.connectorDraftError):'');
}
// A Personal Pip's own apps (pip_app_links): the Connect card it asks for with connect_app.
let appLinkSeq=0,appLinkBusy='',appLinkTimer=0,appLinkUntil=0;const appLinkHosts=new Map();
// Per card: the accounts Composio answered with, for the person to choose from, and the cards just linked (one quiet line until the next message).
const appLinkChoices=new Map(),appLinkSettled=new Set();
async function loadAppLinks(){
 if(remoteHost||S.apiVersion<43||!personalPip()||!usable())return;
 const token=scope(),sequence=++appLinkSeq,pip=S.selected;
 try{const page=appLinksPage(await send('list_pip_app_links',{pip_id:pip}),pip);if(token!==scope()||sequence!==appLinkSeq||S.selected!==pip)return;
  S.appLinks=page.links;S.composio=page.composio;S.appLinksError='';render();watchAppSignIn();}
 catch(error){if(token===scope()&&sequence===appLinkSeq){S.appLinksError=errorText(error);render();}}
}
function appLinkCards(){
 if(remoteHost||S.apiVersion<43||!personalPip())return '';
 const pipName=S.pip?.name||'This Pip';
 const cards=shownAppLinks(S.appLinks).map(link=>appLinkMarkup(link,{esc,busy:appLinkBusy===link.id||S.busy||archived(),composio:S.composio!==false,host:appLinkHosts.get(link.id)||'',pipName,choice:appLinkChoices.get(link.id)||null}));
 return cards.join('')+(S.appLinksError?`<p class="app-link-note" role="alert">${esc(S.appLinksError)}</p>`:'');
}
// A card that changed takes its place in the list. A Pip can hold several accounts of one app (pips-09): its other
// linked accounts stay; a new open or linked card replaces that app's other cards that aren't linked.
function putAppLink(link){S.appLinks=[link,...(S.appLinks||[]).filter(l=>l.id!==link.id&&(l.toolkit!==link.toolkit||(l.status==='connected'?!(link.status==='connected'&&l.account===link.account):link.status==='declined')))];}
// A Personal Pip's plugins (pip_plugins): it asks with use_plugin and you Allow it on its card. What it
// would then do in a plugin is an Allow card here: Allow, Always allow (never for a plugin that can
// move money) or Don't. The same reviewed steps as the connector dialogs, without them.
S.plugins=[];S.pluginsInstalled=[];S.pluginsError='';let pluginSeq=0,pluginBusy='';const pluginDrafts=new Map();
// pips-10 (Pips API 81): a plugin that needs a key asks for it on a card. What is kept here is never the key: which
// cards wait (S.keyRequests), whether every box of a card has text (keyFilled, so a redraw keeps Allow on), what DGC
// said of a refused one (keyErrors), and which were saved in this chat (keySaved). The key is read from its box when
// Allow is pressed, sent once, and the box emptied.
S.keyRequests=[];const keyFilled=new Set(),keyErrors=new Map(),keySaved=new Map();
const keyCards=()=>S.apiVersion>=81&&!remoteHost&&personalPip();
const keyBoxes=id=>[...document.querySelectorAll('[data-key-card] input[data-key-name]')].filter(box=>box.closest('[data-key-card]').dataset.keyCard===id);
function keyTyped(box){
 const card=box.closest('[data-key-card]'),id=card?.dataset.keyCard;if(!id)return;
 const full=keyBoxes(id).every(b=>b.value.trim());
 if(full)keyFilled.add(id);else keyFilled.delete(id);
 const allow=card.querySelector('button.primary');if(allow&&!pluginBusy)allow.disabled=!full;
}
async function keyAllow(id){
 const card=(S.keyRequests||[]).find(c=>c.id===id);
 if(!card||!keyCards()||!usable()||pluginBusy||archived()||S.busy)return;
 const boxes=keyBoxes(id);let keys={};
 for(const k of card.needs_key){const box=boxes.find(b=>b.dataset.keyName===k.name),value=(box?.value||'').trim();if(!value)return;keys[k.name]=value;}
 for(const box of boxes)box.value='';
 keyFilled.delete(id);keyErrors.delete(id);
 const token=scope(),pip=S.selected,pipName=S.pip?.name||'This Pip';pluginBusy=id;
 // (Handed to the channel and let go: nothing here holds the key while DGC answers.)
 const pending=send('allow_pip_plugin',{pip_id:pip,grant_id:id,keys});keys=null;render();
 try{const done=pluginResult(await pending,pip,id);if(token!==scope()||S.selected!==pip)return;
  S.keyRequests=(S.keyRequests||[]).filter(c=>c.id!==id);keySaved.set(id,card);
  S.notice=`${pipName} can use ${done.name} now.`;void loadMessages();void loadPluginDrafts();
 }catch(error){if(token===scope())keyErrors.set(id,errorText(error));}
 finally{if(token===scope()){pluginBusy='';render();}}
}
document.addEventListener('input',event=>{const box=event.target;if(box?.dataset?.keyName)keyTyped(box);});
document.addEventListener('submit',event=>{const id=event.target?.dataset?.keyForm;if(!id)return;event.preventDefault();void keyAllow(id);});
// A Personal Pip's own API keys (pips-10, Pips API 82): the Pip asks for a web API's key on a card (src/pipKeys.js); DGC
// keeps it and sends it to the card's one site, and the Pip never sees it. What is kept here is never the key: what DGC
// lists (S.pipKeys: names, sites, where each stands), whether a card's box has text (pipKeyFilled, so a redraw keeps Save
// on), what DGC said of one it wouldn't keep (pipKeyErrors), which were answered in this chat (pipKeyDone: "saved" or
// "declined") and which the page is asking about removing (pipKeyConfirm). The key is read from its box when Save is
// pressed, sent once, and the box emptied.
S.pipKeys=[];S.pipKeysError='';let pipKeysSeq=0,pipKeyBusy='',pipKeyConfirm='';const pipKeyFilled=new Set(),pipKeyErrors=new Map(),pipKeyDone=new Map();
// Slice 2c (Pips API 85): a site's key card offers "Also let its Terminal use it" only while this Pip is known to be at
// Do it all and has a computer. Which cards are ticked (pipKeyTicked) is kept across a redraw; none is ticked to begin.
const pipKeyTicked=new Set();
const pipKeyTerminalOffered=()=>S.apiVersion>=85&&pipKeysShown()&&!!S.pip?.computer_plan&&levelState.pip===S.selected&&levelState.value?.level==='full';
const pipKeysShown=()=>S.apiVersion>=82&&!remoteHost&&personalPip();
const pipKeyBox=id=>[...document.querySelectorAll('input[data-pip-key-box]')].find(box=>box.dataset.pipKeyBox===id)||null;
function pipKeyTyped(box){
 const id=box.dataset.pipKeyBox,full=!!box.value.trim();
 if(full)pipKeyFilled.add(id);else pipKeyFilled.delete(id);
 const save=box.closest('[data-pip-key-card]')?.querySelector('button.primary');if(save&&!pipKeyBusy)save.disabled=!full;
}
async function loadPipKeys(){
 if(!pipKeysShown()||!usable())return;
 const token=scope(),sequence=++pipKeysSeq,pip=S.selected;
 try{const keys=pipKeysPage(await send('list_pip_keys',{pip_id:pip}),pip);if(token!==scope()||sequence!==pipKeysSeq||S.selected!==pip)return;
  S.pipKeys=keys;S.pipKeysError='';
  for(const id of [...pipKeyFilled,...pipKeyErrors.keys()])if(!keys.some(k=>k.id===id&&k.status==='requested')){pipKeyFilled.delete(id);pipKeyErrors.delete(id);}
  for(const id of [...pipKeyTicked])if(!keys.some(k=>k.id===id&&k.status==='requested'))pipKeyTicked.delete(id);
  for(const k of keys)if(k.status==='requested')pipKeyDone.delete(k.id);   // asked for again (its site turned the key away): the card is back
  if(pipKeyConfirm&&!keys.some(k=>k.id===pipKeyConfirm))pipKeyConfirm='';
  render();}
 catch(error){if(token===scope()&&sequence===pipKeysSeq){S.pipKeysError=errorText(error);render();}}
}
async function pipKeySave(id){
 const key=(S.pipKeys||[]).find(k=>k.id===id&&k.status==='requested');
 if(!key||!pipKeysShown()||!usable()||pipKeyBusy||archived()||S.busy)return;
 const box=pipKeyBox(id);let value=(box?.value||'').trim();if(!value)return;
 box.value='';pipKeyFilled.delete(id);pipKeyErrors.delete(id);
 // Its Terminal too: only when the tick is on the card now (Do it all, with a computer) and ticked. Otherwise never sent.
 const terminal=key.kind==='site'&&pipKeyTerminalOffered()&&pipKeyTicked.has(id);
 const token=scope(),pip=S.selected;pipKeyBusy=id;
 // (Handed to the channel and let go: nothing here holds the key while DGC answers.)
 const pending=send('save_pip_key',{pip_id:pip,key_id:id,value,...(terminal?{terminal:true}:{})});value='';render();
 try{const saved=pipKeyResult(await pending,pip,id);if(token!==scope()||S.selected!==pip)return;
  pipKeysSeq++;S.pipKeys=(S.pipKeys||[]).map(k=>k.id===id?saved:k);
  if(saved.status==='saved'){pipKeyTicked.delete(id);pipKeyDone.set(id,{key:saved,how:'saved'});void loadMessages();}   // the Pip carries on by itself
 }catch(error){if(token===scope())pipKeyErrors.set(id,errorText(error));}
 finally{if(token===scope()){pipKeyBusy='';render();}}
}
async function pipKeyDecline(id){
 if(!pipKeysShown()||!usable()||pipKeyBusy||archived()||S.busy)return;
 const box=pipKeyBox(id);if(box)box.value='';pipKeyFilled.delete(id);pipKeyErrors.delete(id);pipKeyTicked.delete(id);   // Not now: whatever was typed is gone
 const token=scope(),pip=S.selected;pipKeyBusy=id;render();
 try{const key=pipKeyResult(await send('decline_pip_key',{pip_id:pip,key_id:id}),pip,id);if(token!==scope()||S.selected!==pip)return;
  pipKeysSeq++;S.pipKeys=(S.pipKeys||[]).map(k=>k.id===id?key:k);
  if(key.status==='declined'){pipKeyDone.set(id,{key,how:'declined'});void loadMessages();}   // the Pip says what it couldn't do
 }catch(error){if(token===scope())pipKeyErrors.set(id,errorText(error));}
 finally{if(token===scope()){pipKeyBusy='';render();}}
}
async function pipKeyRemove(id){
 const key=(S.pipKeys||[]).find(k=>k.id===id);
 if(!key||!pipKeysShown()||!usable()||pipKeyBusy||S.busy)return;
 const token=scope(),pip=S.selected,pipName=S.pip?.name||'This Pip';pipKeyBusy=id;S.pipKeysError='';render();
 try{const answer=await send('remove_pip_key',{pip_id:pip,key_id:id});if(token!==scope()||S.selected!==pip)return;
  if(answer?.removed!==true)throw new Error('DGC didn’t say it was removed. Refresh the Pip.');
  pipKeysSeq++;S.pipKeys=(S.pipKeys||[]).filter(k=>k.id!==id);pipKeyDone.delete(id);pipKeyFilled.delete(id);pipKeyErrors.delete(id);pipKeyTicked.delete(id);pipKeyConfirm='';
  S.notice=pipKeyRemovedNote(key,pipName);
 }catch(error){if(token===scope())S.pipKeysError=errorText(error);}
 finally{if(token===scope()){pipKeyBusy='';render();void loadPipKeys();}}
}
// In the chat, under the reply that asked: each key still waited for, then what was answered here.
function pipKeyCards(){
 if(!pipKeysShown())return '';
 const pipName=S.pip?.name||'This Pip',off=archived()||S.busy;
 const asking=waitingKeys(S.pipKeys).map(k=>pipKeyCardMarkup(k,{esc,busy:pipKeyBusy===k.id||off,pipName,filled:pipKeyFilled.has(k.id),error:pipKeyErrors.get(k.id)||'',terminal:pipKeyTerminalOffered(),ticked:pipKeyTicked.has(k.id)}));
 const done=[...pipKeyDone.values()].map(d=>pipKeyCardMarkup(d.key,{esc,pipName,done:d.how}));
 return asking.join('')+done.join('')+(S.pipKeysError?`<p class="app-link-note" role="alert">${esc(S.pipKeysError)}</p>`:'');
}
document.addEventListener('input',event=>{const box=event.target;if(box?.dataset?.pipKeyBox)pipKeyTyped(box);});
document.addEventListener('change',event=>{const tick=event.target,id=tick?.dataset?.pipKeyTerminal;if(!id)return;if(tick.checked)pipKeyTicked.add(id);else pipKeyTicked.delete(id);});
document.addEventListener('submit',event=>{const id=event.target?.dataset?.pipKeyForm;if(!id)return;event.preventDefault();void pipKeySave(id);});
// A webhook routine's signing secret, and an address of your own for calls from the internet (pipWebhooks.js).
document.addEventListener('submit',event=>{const d=event.target?.dataset;if(!d)return;
 if(d.hookSigningForm!==undefined){event.preventDefault();saveHookSigning();return;}
 if(d.reachOwnForm!==undefined){event.preventDefault();if(S.busy)return;const own=String(draft.hookOwnBase||'').trim();
  if(!/^https:\/\/\S+$/.test(own)){pipsSettings.reachRefusal='Type the address as https://your.domain/path.';render();$('hookOwnBase')?.focus();return;}
  void reachCall({tunnel:'own',own_base:own},'own','Saved. Services on the internet reach your routines through your own address.');}});
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
 void loadOwnApps();void loadPipKeys();
 if(remoteHost||S.apiVersion<44||!personalPip()||!usable())return;
 const token=scope(),sequence=++pluginSeq,pip=S.selected;
 try{const answer=await send('list_pip_plugins',{pip_id:pip}),page=pluginsPage(answer,pip),asking=keyCards()?keyRequests(answer,pip):[];if(token!==scope()||sequence!==pluginSeq||S.selected!==pip)return;
  S.plugins=page.plugins;S.pluginsInstalled=page.installed;S.keyRequests=asking;S.pluginsError='';
  for(const id of [...keyFilled,...keyErrors.keys()])if(!asking.some(c=>c.id===id)){keyFilled.delete(id);keyErrors.delete(id);}
  render();void loadPluginDrafts();}
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
  .map(({draft,plugin})=>pluginActionMarkup(draft,plugin,{esc,busy:pluginBusy===draft.id||off,pipName,edit:cardEdit(draft),logo:pluginLogoSrc,accountLabel:id=>(S.appLinks||[]).find(l=>l.account===id)?.label||''}));
 actions.push(ownAppDecidedCards(),pluginNotRun());
 const cards=shownPluginCards(S.plugins).map(c=>pluginCardMarkup(c,{esc,busy:pluginBusy===c.id||off,pipName}));
 // A plugin that needs a key (API 81): its card with a box for the key; saved here, it says so.
 const asking=keyCards()?(S.keyRequests||[]).map(c=>keyCardMarkup(c,{esc,busy:pluginBusy===c.id||off,pipName,filled:keyFilled.has(c.id),error:keyErrors.get(c.id)||'',logo:pluginLogoSrc})):[];
 const kept=keyCards()?[...keySaved.values()].map(c=>keyCardMarkup(c,{esc,pipName,saved:true,logo:pluginLogoSrc})):[];
 return actions.join('')+cards.join('')+asking.join('')+kept.join('')+(S.pluginsError?`<p class="app-link-note" role="alert">${esc(S.pluginsError)}</p>`:'');
}
// Don't on a plugin's Allow card says so where the card was, under the reply that offered it, while that reply is the
// latest (and after a reload): "Not run." showed above the chat, out of sight, and the reply still said its card was
// below (release check, 2026-11-03).
function pluginNotRun(){
 const last=(S.messages||[]).filter(m=>m.role==='assistant').at(-1);
 return last?(S.connectorDrafts||[]).filter(d=>d.status==='dismissed'&&d.source_run_id===last.run_id)
  .map(d=>`<p class="app-link-note plugin-not-run" role="status" data-plugin-not-run="${esc(d.id)}">Not run: you chose Don’t${d.subject?` for ${esc(d.subject)}`:''}.</p>`).join(''):'';
}
// @ a project in a Personal Pip's chat (pips-21, Pips API 91; src/pipProjects.js). The @ list offers this computer's
// projects; naming one gives the Pip a private copy on its computer, and what it changed there comes back as one card per
// project under its reply: Apply (always your click), Discard (asked first), Undo after Apply, and Continue in Work.
// DGC compares the copies only when asked, so it is asked when the chat opens and when a reply lands, never on a look.
S.projectChoices=[];S.projectChanges=[];S.projectsError='';
let projectChoicesSeq=0,projectChoicesAt=0,projectChoicesBusy=false,projectChangesSeq=0,projectAsked='',projectBusy=null,projectConfirm='',projectNeedsComputer='',projectRefused=false;
const projectOpen=new Set(),projectDiffs=new Map(),projectErrors=new Map(),projectNotes=new Map();
const projectsOn=()=>S.apiVersion>=PROJECTS_API&&!remoteHost&&(personalPip()||folderBox()||flowCards()&&S.apiVersion>=FLOW_API);
// A project's mark travels as a display mention, so only where DGC keeps a message's marks; an archived Pip takes no message.
const projectMentionsOn=()=>projectsOn()&&!!Mentions&&S.displayMentions&&!archived();
function resetProjects(){S.projectChoices=[];S.projectChanges=[];S.projectsError='';projectChoicesSeq++;projectChoicesAt=0;projectChoicesBusy=false;projectChangesSeq++;projectAsked='';projectBusy=null;projectConfirm='';projectNeedsComputer='';projectRefused=false;projectOpen.clear();projectDiffs.clear();projectErrors.clear();projectNotes.clear();}
async function loadProjectChoices(){
 if(!projectMentionsOn()||!usable()||projectChoicesBusy||Date.now()-projectChoicesAt<5000)return;
 const token=scope(),sequence=++projectChoicesSeq,pip=S.selected;projectChoicesBusy=true;
 try{const list=projectChoices(await send('list_pip_project_choices',{pip_id:pip}));if(token!==scope()||sequence!==projectChoicesSeq)return;S.projectChoices=list;projectChoicesAt=Date.now();chatPicker?.refresh();}
 catch{/* the list stays as it was: the other kinds are still offered */}
 finally{if(sequence===projectChoicesSeq)projectChoicesBusy=false;}
}
// `refused`: DGC itself said so (this page's own idea of the Pip was behind), so the line stays whatever the page thinks.
function askForComputer(pip=S.selected,refused=false){projectNeedsComputer=pip;projectRefused=refused;render();}
// A goal for a Personal Pip's conversation (pips-15, Pips API 92; pipGoal.js): its card above the prompt box. Read when
// the chat opens and after each reply lands; while it is working with no reply in sight (between two of its turns) it
// is read again every few seconds, and a turn that moved brings the chat's new messages in.
const goalsDismissed=new Set(Array.isArray(savedView?.goals_dismissed)?savedView.goals_dismissed.filter(g=>typeof g==='string'&&/^pipgoal_[0-9a-f]{32}$/.test(g)).slice(-100):[]);
const goalState={pip:'',conv:'',value:null,error:'',busy:false,open:false,details:false,seq:0,timer:0};
function goalsOn(){return S.apiVersion>=GOALS_API&&!remoteHost&&!!S.pip&&keepsAll()&&!archived();}
function resetGoal(){window.clearTimeout(goalState.timer);goalState.timer=0;goalState.pip='';goalState.conv='';goalState.value=null;goalState.error='';goalState.busy=false;goalState.open=false;goalState.details=false;goalState.seq++;}
function goalShown(){const g=goalState.pip===S.selected&&goalState.conv===(S.conv||'')?goalState.value:null;return g&&!goalsDismissed.has(g.id)?g:null;}
function goalCard(){
 if(!goalsOn())return '';
 return goalCardMarkup(goalShown(),{esc,busy:goalState.busy||!usable(),open:goalState.open,details:goalState.details,error:goalState.error,pipName:S.pip?.name||'This Pip'});
}
function watchGoal(){
 window.clearTimeout(goalState.timer);goalState.timer=0;
 if(!goalsOn()||goalShown()?.status!=='active')return;
 goalState.timer=window.setTimeout(()=>{goalState.timer=0;if(S.tab==='chat'||$('chat-form'))void loadGoal(true);else watchGoal();},4000);
}
async function loadGoal(watching=false){
 if(!goalsOn()||!usable()){if(goalState.pip)resetGoal();return;}
 const token=scope(),pip=S.selected,conv=S.conv||'',sequence=++goalState.seq;
 try{const value=pipGoalRead(await send('get_pip_goal',{pip_id:pip,...convArg()}),pip);if(token!==scope()||sequence!==goalState.seq||S.selected!==pip||(S.conv||'')!==conv)return;
  const before=goalState.pip===pip&&goalState.conv===conv?goalState.value:null,moved=!!before&&!!value&&before.id===value.id&&(before.turns!==value.turns||before.status!==value.status);
  if(before?.id!==value?.id){goalState.open=false;goalState.details=false;}
  goalState.pip=pip;goalState.conv=conv;goalState.value=value;goalState.error='';
  if(JSON.stringify(before)!==JSON.stringify(value))render();
  // Seen by the watch: a turn of its own ended or began, so its reply is in the chat now.
  if(watching&&moved)void loadMessages();}
 catch(error){if(token===scope()&&sequence===goalState.seq&&S.selected===pip&&!watching){goalState.error=errorText(error);render();}}
 finally{if(token===scope()&&S.selected===pip)watchGoal();}
}
async function setGoal(objective,typed){
 if(!goalsOn()||!usable()||goalState.busy)return;
 const name=S.pip?.name||'this Pip';
 if(!objective){setError(`Say what the goal is after /goal: what ${name} should keep working on until it is done.`);return;}
 if([...objective].length>MAX_OBJECTIVE){setError(`Say what the goal is, in up to ${MAX_OBJECTIVE.toLocaleString('en-US')} characters. Nothing was set.`);return;}
 const token=scope(),pip=S.selected,conv=S.conv||'';
 // As a sent message clears the box: the box itself and what the page keeps for a reload (a reload brought the last
 // "/goal ..." back, and the next one was typed into the middle of it; 12 Nov).
 goalState.busy=true;S.error='';chatEdit(()=>{draft.chatText='';const box=$('chatText');if(box)box.value='';chatDrafts.set(pip,'');rememberView();render();});
 try{const value=pipGoal((await send('set_pip_goal',{pip_id:pip,objective,...convArg()}))?.goal,pip);if(token!==scope()||S.selected!==pip)return;
  if(!value)throw Error('DGC didn’t confirm the goal. Try again.');
  goalState.seq++;goalState.pip=pip;goalState.conv=conv;goalState.value=value;goalState.error='';goalState.open=false;goalState.details=false;
  void loadMessages();}
 catch(error){if(token===scope()&&S.selected===pip){chatEdit(()=>{if(!draft.chatText.trim())draft.chatText=typed;});setError(error);}}
 finally{goalState.busy=false;if(token===scope()&&S.selected===pip){render();watchGoal();$('chatText')?.focus();}}
}
async function stopGoal(){
 const goal=goalShown();if(!goalsOn()||!usable()||goalState.busy||!goalLive(goal))return;
 const token=scope(),pip=S.selected;goalState.busy=true;goalState.error='';render();
 try{const value=pipGoal((await send('stop_pip_goal',{pip_id:pip,goal_id:goal.id}))?.goal,pip);if(token!==scope()||S.selected!==pip)return;
  if(!value||value.id!==goal.id)throw Error('DGC answered about another goal. Open the chat again.');
  goalState.seq++;goalState.value=value;}
 catch(error){if(token===scope()&&S.selected===pip)goalState.error=errorText(error);}
 finally{goalState.busy=false;if(token===scope()&&S.selected===pip){render();watchGoal();}}
}
function dismissGoal(){const goal=goalShown();if(!goal||goalLive(goal))return;goalsDismissed.add(goal.id);goalState.details=false;rememberView();render();$('chatText')?.focus();}
function needsComputerCard(){
 if(!projectsOn()||projectNeedsComputer!==S.selected||(S.pip?.computer_plan&&!projectRefused)||archived())return '';
 return needsComputerMarkup(S.pip?.name,{esc,off:S.busy||!usable()});
}
// A reply landed, or the chat opened: what did the Pip change in its copies? `page`: the chat as just read.
function projectChangesDue(pip,page){
 if(!projectsOn()||S.tab!=='chat')return;
 const last=[...S.messages].reverse().find(m=>m.role==='assistant'),first=!projectAsked.startsWith(pip+'|'+(S.conv||'')+'|');
 const key=`${pip}|${S.conv||''}|${last?.id||''}|${page.active_run?'writing':'idle'}`;
 if(key===projectAsked)return;projectAsked=key;
 if(first||!page.active_run)void loadProjectChanges();
}
async function loadProjectChanges(){
 if(!projectsOn()||!usable())return;
 const token=scope(),sequence=++projectChangesSeq,pip=S.selected;
 try{const list=projectChanges(await send('list_pip_project_changes',{pip_id:pip}),pip);if(token!==scope()||sequence!==projectChangesSeq)return;
  S.projectChanges=list;S.projectsError='';
  // What is kept is only for the changes still listed, as they are now; an open file of a change that grew is read again.
  const now=new Map(list.map(c=>[c.id,c]));
  for(const key of [...projectDiffs.keys()]){const [id,digest]=key.split('|');if(now.get(id)?.digest!==digest||now.get(id)?.status!=='pending'&&!onePips())projectDiffs.delete(key);}
  for(const key of [...projectOpen]){const at=key.indexOf('|'),c=now.get(key.slice(0,at)),path=key.slice(at+1);if(!c||c.status!=='pending'&&!onePips()||!c.files.some(f=>f.path===path))projectOpen.delete(key);else void loadProjectDiff(c.id,path);}
  for(const map of [projectErrors,projectNotes])for(const id of [...map.keys()])if(!now.has(id))map.delete(id);
  if(projectConfirm&&now.get(projectConfirm)?.status!=='pending')projectConfirm='';
  render();}
 catch(error){if(token===scope()&&sequence===projectChangesSeq){S.projectsError=errorText(error);render();}}
}
function projectChangeCards(){
 if(!projectsOn())return '';
 const lastUserAt=Math.max(0,...(S.messages||[]).filter(m=>m.role==='user'&&m.intro!==true).map(m=>Date.parse(m.created_at)||0));
 const off=archived()||!usable();
 const withFix=flowChangeIds();
 return shownProjectChanges(S.projectChanges,{lastUserAt}).filter(c=>!withFix.has(c.id)).map(c=>projectCardMarkup(c,{one:onePips(),canCommit:S.apiVersion>=FLOW_API,esc,open:projectOpen,diffs:projectDiffs,busy:projectBusy?.id===c.id?projectBusy.what:'',off:off||(!!projectBusy&&projectBusy.id!==c.id),
   confirm:projectConfirm===c.id,note:projectNotes.get(c.id)||'',error:projectErrors.get(c.id)||''})).join('')
  +(S.projectsError?`<p class="app-link-note" role="alert">${esc(S.projectsError)}</p>`:'');
}
async function loadProjectDiff(id,path){
 const change=S.projectChanges.find(c=>c.id===id);if(!change||!usable())return;
 const key=`${id}|${change.digest}|${path}`;if(projectDiffs.has(key))return;
 const token=scope(),pip=S.selected,entry={loading:true,text:'',error:''};projectDiffs.set(key,entry);render();
 try{const got=await send('get_pip_project_change',{pip_id:pip,change_id:id,path});if(typeof got?.diff!=='string'||got.id!==id||got.path!==path)throw new Error('This file’s changes didn’t load. Open it again.');entry.text=got.diff;}
 catch(error){entry.error=errorText(error);}
 finally{entry.loading=false;if(token===scope()&&projectDiffs.get(key)===entry)render();}
}
function toggleProjectFile(id,path){
 const key=`${id}|${path}`,change=S.projectChanges.find(c=>c.id===id);if(!change)return;
 if(projectOpen.has(key)){projectOpen.delete(key);render();return;}
 projectOpen.add(key);const kept=`${id}|${change.digest}|${path}`;if(projectDiffs.get(kept)?.error)projectDiffs.delete(kept);
 render();void loadProjectDiff(id,path);
}
// Apply, Discard and Undo: each is the user's click on this card, and each answers the change as DGC now lists it.
async function projectDecide(what,id){
 const change=S.projectChanges.find(c=>c.id===id);if(!change||!usable()||!projectsOn()||projectBusy||archived())return;
 const token=scope(),pip=S.selected,type={apply:'apply_pip_project_change',discard:'discard_pip_project_change',undo:'undo_pip_project_change'}[what];
 projectBusy={id,what};projectErrors.delete(id);projectNotes.delete(id);render();
 try{const decided=projectAnswer(await send(type,{pip_id:pip,change_id:id,...(what==='apply'?{expected_digest:change.digest}:{})}),id);if(token!==scope()||S.selected!==pip)return;
  S.projectChanges=S.projectChanges.map(c=>c.id===id?decided:c);projectConfirm='';
  for(const key of [...projectOpen])if(key.startsWith(id+'|'))projectOpen.delete(key);
  // What Apply held back is still different in the Pip's copy: DGC lists it as a change of its own.
  if(what==='apply')void loadProjectChanges();}
 catch(error){if(token!==scope()||S.selected!==pip)return;
  // The Pip changed more since this card was drawn: nothing was applied. The change is read and shown again.
  if(what==='apply'&&error?.code==='conflict'){projectNotes.set(id,MOVED_ON);await loadProjectChanges();}
  else projectErrors.set(id,errorText(error));}
 finally{if(projectBusy?.id===id)projectBusy=null;if(token===scope())render();}
}
// Continue in Work: the editor opens a new Work chat in this project, with the change's patch as a file beside its first
// message. Nothing is decided here: the change still waits in this chat.
async function projectWork(id){
 if(!S.projectChanges.some(c=>c.id===id)||!usable()||!projectsOn()||projectBusy)return;
 const token=scope(),pip=S.selected;projectBusy={id,what:'work'};projectErrors.delete(id);render();
 try{await send(PROJECT_WORK_COMMAND,{pip_id:pip,change_id:id});}
 catch(error){if(token===scope()&&S.selected===pip)projectErrors.set(id,errorText(error));}
 finally{if(projectBusy?.id===id)projectBusy=null;if(token===scope())render();}
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
 for(const box of keyBoxes(id))box.value='';keyFilled.delete(id);keyErrors.delete(id);   // a key card answered Not now: its boxes are emptied
 const token=scope(),pip=S.selected,pipName=S.pip?.name||'This Pip';pluginBusy=id;render();
 try{const card=pluginResult(await send(type,{pip_id:pip,grant_id:id}),pip,id);if(token!==scope()||S.selected!==pip)return;
  S.keyRequests=(S.keyRequests||[]).filter(c=>c.id!==id);
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
 if(edit)edit.error='';always=always&&!plugin.asks;pluginBusy=id;render();
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
let routineSeq=0,routineEditing='',routineBusy='',routineError='',pageNameDirty=false,titleEditing=false,lookDirty=false,profileBusy=false;
const shared={pip:'',kind:'',items:null,error:'',loading:false,seq:0,desk:null};
const pipsSettings={view:'',computers:null,computersError:'',apps:null,appsError:'',plugins:null,pluginsError:'',confirmReset:'',seq:0,busy:false};
Object.assign(draft,{pipPageName:'',pipPageTitle:'',pipInstructions:'',lookBody:''},routineDraft(null,defaultZone));
// A Personal Pip's chosen face and colour; any other Pip keeps the face its type gives it.
function pipAvatar(p,state,key,type){const look=profile(p?.profile),own=personalPip(p);return avatar(state,own&&look.body?characterType(look.body):type,key);}
function sameJson(a,b){const norm=v=>Array.isArray(v)?v.map(norm):record(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,norm(v[k])])):v;return JSON.stringify(norm(a))===JSON.stringify(norm(b));}
async function loadRoutines(){
 if(remoteHost||S.apiVersion<43||!keepsAll()||!usable())return;
 const token=scope(),sequence=++routineSeq,pip=S.selected;
 // From Pips API 63 its routines on your own app's events too (an older DGC lists none and takes no such field), and
 // from API 90 the ones a service calls.
 try{const list=routinesPage(await send('list_pip_routines',{pip_id:pip,...(appEventRoutines()?{app_events:true}:{}),...(webhookRoutines()?{webhooks:true}:{})}),pip);if(token!==scope()||sequence!==routineSeq)return;S.routines=list;S.routinesError='';render();}
 catch(error){if(token===scope()&&sequence===routineSeq){S.routinesError=errorText(error);render();}}
}
function routineCards(){
 if(remoteHost||S.apiVersion<43||!keepsAll()||!S.routines)return '';
 return shownRoutineCards(S.routines).map(r=>routineCardMarkup(r,{esc,busy:routineBusy===r.id||S.busy||archived()||!usable(),formatDate:date})).join('');
}
async function routineCall(command,args,id,notice){
 if(S.busy||!usable()||routineBusy)return null;const token=scope(),pip=S.selected;routineBusy=id||'form';routineError='';render();
 try{const result=await send(command,{pip_id:pip,...args});if(token!==scope())return null;if(notice)S.notice=(typeof notice==='function'?notice(result):notice)+keepRunningTold(result);await loadRoutines();return result||{};}
 catch(error){if(token===scope()){routineError=errorText(error);if(!routineEditing)S.error=routineError;}return null;}
 finally{if(token===scope()){routineBusy='';render();}}
}
function routineStartNotice(result){
 const routine=result?.routine,kind=routine?.trigger?.kind;
 if(kind==='webhook')return 'Routine added. Paste its address into the service that calls it.';
 const toolkit=kind==='email'?'gmail':kind==='calendar'?'googlecalendar':'';
 if(toolkit&&!(S.appLinks||[]).some(link=>link.status==='connected'&&link.toolkit===toolkit))
  return `Routine saved. It waits for ${kind==='email'?'Gmail':'Google Calendar'} to be linked to this Pip. Use the link card in this chat if shown, or ask this Pip to link the app. DGC can reuse an active Composio account.`;
 return 'Routine added. It runs on its own now.';
}
function editRoutine(id){
 const r=(S.routines||[]).find(x=>x.id===id);if(id!=='new'&&!r)return;
 routineEditing=id;routineError='';Object.assign(draft,routineDraft(id==='new'?null:r,defaultZone,ownAppNames()[0]||''));
 if(r?.trigger.kind==='webhook'&&webhookRoutines()){if(hook.routine!==id||hook.pip!==S.selected)openHook(id);}else closeHook();
 render();$('routineTitle')?.focus();
 if(draft.routineKind==='app')void loadAppEvents(draft.routineApp);
}
// A routine a service calls (Pips API 90, pipWebhooks.js; local only): its panel under its card, open while you edit
// it and right after you add it. Its address is a secret: `hook.shown` is off whenever the panel opens, the whole
// address stays in `hook.value` (never in the page until Show), and nothing here logs it or says it in a notice.
const hook={pip:'',routine:'',value:null,error:'',signingError:'',busy:'',shown:false,tested:'',seq:0};
Object.assign(draft,{hookSecret:'',hookOwnBase:''});
Object.assign(pipsSettings,{reach:null,reachError:'',reachBusy:'',reachRefusal:''});
function webhookRoutines(){return webhooksOffered(S.apiVersion,remoteHost);}
function closeHook(){hook.seq++;Object.assign(hook,{pip:'',routine:'',value:null,error:'',signingError:'',busy:'',shown:false,tested:''});draft.hookSecret='';}
function openHook(id){closeHook();if(!webhookRoutines()||!S.selected)return;hook.pip=S.selected;hook.routine=id;void loadHook();}
async function loadHook(){
 if(!hook.routine||!webhookRoutines()||!usable())return;
 const token=scope(),sequence=++hook.seq,pip=hook.pip,id=hook.routine;
 try{const value=webhook(await send('get_pip_webhook',{pip_id:pip,routine_id:id}),pip,id);if(token!==scope()||sequence!==hook.seq)return;hook.value=value;hook.error='';}
 catch(error){if(token!==scope()||sequence!==hook.seq)return;hook.error=errorText(error);}
 render();
}
async function hookCall(command,args,what,after){
 if(hook.busy||!usable()||!hook.routine||!webhookRoutines())return false;
 const token=scope(),pip=hook.pip,id=hook.routine,mine=()=>token===scope()&&hook.pip===pip&&hook.routine===id;
 hook.seq++;hook.busy=what;hook.error='';hook.signingError='';if(what==='test')hook.tested='';render();
 try{const value=webhook(await send(command,{pip_id:pip,routine_id:id,...args}),pip,id);if(!mine())return false;hook.value=value;after?.(value);return true;}
 catch(error){if(mine()){const words=errorText(error);if(what==='test')hook.tested=words;else if(what==='signing')hook.signingError=words;else hook.error=words;}return false;}
 finally{if(mine()){hook.busy='';render();}}
}
function hookPanel(r){
 if(r.trigger.kind!=='webhook'||!webhookRoutines()||hook.routine!==r.id||hook.pip!==S.selected)return '';
 return webhookPanelMarkup(hook.value,{esc,routineId:r.id,busy:hook.busy,off:S.busy||!usable(),shown:hook.shown,error:hook.error,signingError:hook.signingError,tested:hook.tested,secret:draft.hookSecret,alone:routineEditing!==r.id,formatDate:shortDate});
}
function copyHookAddress(way){
 const address=hook.value?.addresses?.[way];if(!address)return;
 vscode.postMessage({type:'copy',text:address});S.notice='Copied its address.';render();
}
function replaceHookAddress(){
 if(!hook.value||hook.busy||S.busy)return;
 openReview({title:'Replace its address?',description:'The old address stops working at once. Services that use it need the new one.',confirm:'Replace address',working:'Replacing…',danger:true,request:{},
  run:()=>hookCall('replace_pip_webhook_address',{},'replace',()=>{hook.shown=false;hook.tested='';S.notice='Its address is replaced. The old one stopped working.';})});
}
function saveHookSigning(remove=false){
 if(!hook.value||hook.busy||S.busy)return;
 const secret=remove?null:String(draft.hookSecret||'').trim();
 if(!remove&&!secret){hook.signingError='Paste the secret first.';render();$('hookSecret')?.focus();return;}
 void hookCall('set_pip_webhook_signing',{secret},'signing',()=>{draft.hookSecret='';const box=$('hookSecret');if(box)box.value='';
  S.notice=remove?'Removed. Calls are no longer checked for a signature.':'Saved. DGC refuses calls this secret didn’t sign.';});
}
// A dialog whose Confirm runs something of the page's own (`review.run`): it stays open, saying what is under way,
// until that ends; what went wrong is said where the control is, not in the dialog.
async function runReview(review){
 if(S.busy)return;S.busy=true;render();renderReview();
 try{await review.run();}catch{/* said by what ran */}
 finally{S.busy=false;if(S.review===review)closeReview();render();}
}
// How calls reach this computer (Pips settings → Webhooks). Turning on Tailscale Funnel can take half a minute.
async function reachCall(args,what,notice){
 if(pipsSettings.reachBusy||!usable()||!webhookRoutines())return false;
 const token=S.epoch;pipsSettings.reachBusy=what;pipsSettings.reachRefusal='';render();
 try{const value=webhookReach(await send('set_webhook_reach',args));if(token!==S.epoch)return false;pipsSettings.reach=value;pipsSettings.reachError='';
  if(what==='own')draft.hookOwnBase='';S.notice=typeof notice==='function'?notice(value):notice;return true;}
 catch(error){if(token===S.epoch)pipsSettings.reachRefusal=errorText(error);return false;}
 finally{pipsSettings.reachBusy='';if(token===S.epoch)render();}
}
function askTailscale(){
 const ts=pipsSettings.reach?.tunnel?.tailscale;if(!ts||pipsSettings.reachBusy||S.busy)return;
 openReview({title:'Use Tailscale Funnel?',description:ts.opens,confirm:'Turn on',working:'Turning on…',request:{},
  run:()=>reachCall({tunnel:'tailscale'},'tailscale','Tailscale Funnel is on. Services on the internet can call your routines’ addresses.')});
}
function openReachSettings(){
 routineEditing='';routineError='';closeHook();clearSelection();S.selected='';S.create=false;S.overview=true;rememberView();
 pipsSettings.view='webhooks';pipsSettings.reachRefusal='';render();void loadPipsSettings();
}
// A routine on your own app's event (Pips API 63): choose the app, then type the event or pick one it sent lately.
const appEventNames=new Map();let appEventsSeq=0;
function appEventRoutines(){return S.apiVersion>=63&&!remoteHost;}
function ownAppNames(){return appEventRoutines()?(S.ownApps||[]).map(a=>a.name):[];}
async function loadAppEvents(app){
 if(!appEventRoutines()||!app||!usable())return;
 const token=scope(),sequence=++appEventsSeq;
 try{const result=await send('list_app_events',{app,limit:20});if(token!==scope()||sequence!==appEventsSeq)return;
  appEventNames.set(app,Array.isArray(result?.names)?result.names.filter(n=>typeof n==='string'&&/^[a-z0-9_.-]{1,64}$/.test(n)).slice(0,50):[]);
  if(routineEditing&&draft.routineKind==='app'&&draft.routineApp===app)render();}
 catch{/* typing the event's name still works */}
}
async function saveRoutine(){
 const isNew=routineEditing==='new',current=(S.routines||[]).find(x=>x.id===routineEditing);
 let value;try{value=routineFromDraft(draft.routineKind==='custom'?{...draft,routineKind:'daily'}:draft);}catch(error){routineError=errorText(error);render();return;}
 if(isNew){const added=await routineCall('add_pip_routine',value,'form',routineStartNotice);
  // One a service calls: its panel opens under its card, with the address to paste.
  if(added){routineEditing='';if(added.routine?.trigger?.kind==='webhook'&&typeof added.routine.id==='string')openHook(added.routine.id);}render();return;}
 if(!current)return;
 const changes={title:value.title,prompt:value.prompt};if(draft.routineKind!=='custom'&&!sameJson(value.trigger,current.trigger))changes.trigger=value.trigger;
 if(await routineCall('update_pip_routine',{routine_id:current.id,changes},'form','Saved.')){routineEditing='';closeHook();}render();
}
function routinesSectionMarkup(short=false){   // short: on its page, where the "i" beside Routines says what one is
 if(S.routinesError&&!S.routines)return errorMarkup(S.routinesError);
 if(!S.routines)return '<p class="muted" role="status">Loading…</p>';
 const links=S.appLinks||[],busy=!!routineBusy||S.busy||!usable();
 const form=routineEditing?routineFormMarkup(draft,{esc,busy,error:routineError,isNew:routineEditing==='new',gmail:links.some(l=>l.status==='connected'&&l.toolkit==='gmail'),calendar:links.some(l=>l.status==='connected'&&l.toolkit==='googlecalendar'),apps:ownAppNames(),events:appEventNames.get(draft.routineApp)||[],webhooks:webhookRoutines()}):'';
 return routinesMarkup(S.routines,{esc,busy,editing:routineEditing,form,formatDate:date,pipName:S.pip.name,short,posts:r=>convList()?routinePostsMarkup(r,convList(),{esc,busy}):'',panel:hookPanel,schedule:S.pip.schedule?scheduleLabel(S.pip.schedule):'',gmail:links.some(l=>l.status==='connected'&&l.toolkit==='gmail'),calendar:links.some(l=>l.status==='connected'&&l.toolkit==='googlecalendar')})+(S.legacyOpen&&S.pip.schedule?`<div class="routine-legacy-edit">${quickScheduleMarkup()}</div>`:'');
}
function routinePopoverMarkup(){
 if(S.composerPanel!=='routines'||!keepsAll()||S.apiVersion<43)return '';
 const count=(S.routines||[]).filter(r=>r.status==='on').length;
 return `<section class="pip-routines-popover dgc-menu from-right" role="dialog" aria-label="${esc(S.pip.name)}’s routines"><div class="pip-routines-head"><strong>Routines</strong><small>${count} on</small><button type="button" id="chat-routines-close" class="quiet" aria-label="Close routines">×</button></div>${routinesSectionMarkup()}</section>`;
}
function openPipPage(view='info'){
 const p=S.pip;if(!p)return;
 S.pipPage=view;draft.pipPageName=p.name;draft.pipPageTitle=profile(p.profile).title;pageNameDirty=false;titleEditing=false;lookDirty=false;routineEditing='';routineError='';closeHook();
 void loadRoutines();void loadAppLinks();void loadPlugins();void loadNotes();void loadCareful();void loadEyes();void loadLevel();void loadPipBackup();void loadTemplate();void loadLogins();void loadArtifacts();void loadAppsUse();void loadSkillsUse();folderUi.open=false;folderUi.adding=false;folderUi.error='';draft.pipFolderName='';noteConfirmAll=false;sitesAll=false;loginsState.confirm='';pipKeyConfirm='';appsUse.confirm='';
}
function putProfile(pipId,value){
 const p={...profile(value),group:pipFolder(value)};if(S.pip?.id===pipId)S.pip={...S.pip,profile:p};S.jobs=S.jobs.map(j=>j.id===pipId?{...j,profile:p}:j);
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
 pageNameDirty=false;titleEditing=false;draft.pipPageName=S.pip?.name||name;draft.pipPageTitle=profile(S.pip?.profile).title;render();
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
 if(archived())return `<section class="pip-page-group"><p class="goal">${esc(p.goal)}</p><p class="muted">Archived. Restore it to use it.</p>${lifecycleMarkup()}</section>`;
 if(S.pipPage==='instructions')return instructionsMarkup({esc,goal:draft.pipInstructions,busy:off,pipName:p.name});
 if(S.pipPage==='character'){
  const own=SIMPLE_CHARACTERS.includes(p.pip_type)?p.pip_type:'core',body=draft.lookBody||own;
  return characterMarkup({esc,body,busy:off,changed:lookDirty,avatarFor:(id,key,state='idle')=>avatar(state,characterType(id||own),`${key}-${p.id}`)});
 }
 const head=headMarkup({esc,avatar:pipAvatar(p,'idle',`page-${p.id}`,pipType(p,S.types)||characterType(p.pip_type)),name:p.name,title:look.title,nameDraft:draft.pipPageName,titleDraft:draft.pipPageTitle,busy:off,dirty:pageNameDirty,titleEditing});
 const tab=['links','media','files'].includes(S.pipPage)?S.pipPage:'info';
 if(tab!=='info'&&(shared.pip!==S.selected||shared.kind!==tab)&&!shared.loading)void loadShared(tab);
 const mine=shared.pip===S.selected&&shared.kind===tab,items=mine?shared.items:null,error=mine?shared.error:'',loading=!mine||shared.loading;
 const body=tab==='links'?linksMarkup(items,{esc,formatDate:shortDate,loading,error})
  :tab==='media'?mediaMarkup(items,{esc,imageSrc:messageImageSrc,loading,error})
  :tab==='files'?filesMarkup(items,mine?shared.desk:null,{esc,formatDate:shortDate,loading,error,hasComputer:computerState.pip===S.selected&&!!computerState.value?.granted})
  :(templateShown()?templateMarkup(templateState.pip===p.id?templateState.value:null,{esc,busy:off||templateState.busy,error:templateState.pip===p.id?templateState.error:'',pipName:p.name}):'')+infoMarkup({esc,goal:p.goal,routines:keepsAll()?routinesSectionMarkup(true):null,notify:look.notify,busy:off,canShare:S.apiVersion>=41&&!remoteHost&&['scout','lens','rook','lock','quill'].includes(p.pip_type),pipName:p.name})+(personalPip()?'':folderPartsMarkup(p))+pipFolderSetMarkup(off)+appsUseMarkup(off)+skillsUseMarkup(off)+computerRowMarkup(p,off)+(S.apiVersion>=53&&!remoteHost&&personalPip()?eyesMarkup(eyesState.pip===p.id?eyesState.value:null,{esc,busy:off||eyesState.busy,error:eyesState.error,pipName:p.name}):'')+(levelShown()?levelMarkup(levelState.pip===p.id?levelState.value:null,{esc,busy:off||levelState.busy,error:levelState.error,pipName:p.name,payLimits:payFormMarkup(levelState.pip===p.id?levelState.value:null),when:at=>shortDate(at)}):'')+artifactsSectionMarkup(p,off)+(S.apiVersion>=44&&!remoteHost&&(personalPip()?p.computer_plan:folderBox())?carefulMarkup(carefulState.pip===p.id?carefulState.value:null,{esc,busy:off||carefulState.busy,error:carefulState.error,pipName:p.name,showAll:sitesAll}):'')+(S.apiVersion>=56&&!remoteHost&&personalPip()&&p.computer_plan?loginsMarkup(loginsState.pip===p.id?loginsState.value:null,{esc,busy:off||loginsState.busy,error:loginsState.error,pipId:p.id,pipName:p.name,names:pipNames(),confirm:loginsState.confirm}):'')+sentSection(off)+(pipKeysShown()?pipKeysPageMarkup(S.pipKeys,{esc,busy:off||!!pipKeyBusy,pipName:p.name,confirm:pipKeyConfirm,error:S.pipKeysError,level:levelState.pip===p.id?levelState.value?.level||'':''}):'')+(S.apiVersion>=44&&!remoteHost&&keepsAll()?notesMarkup(S.notesPip===p.id?S.notes:null,{esc,busy:off||notesBusy,error:S.notesError,pipName:p.name,adding:draft.noteAdd,confirmAll:noteConfirmAll,knows:knowsYou()}):'')+(workingNotesShown()?workingNotesMarkup(S.workingNotesPip===p.id?S.workingNotes:null,{esc,busy:off||workingNotesBusy,error:S.workingNotesError,pipName:p.name,editing:workingNotesEditing,text:draft.workingNotesText})+dailyLogMarkup(S.dailyLogPip===p.id?S.dailyLog:null,{esc,error:S.dailyLogError,pipName:p.name,today:localDay()}):'')+allowedMarkup()+(S.apiVersion>=44&&!remoteHost&&personalPip()?pluginsPageMarkup(S.plugins,{esc,busy:off||!!pluginBusy,pipName:p.name}):'');
 return `<div class="pip-page">${head}${healthMarkup(p.routine_health,{busy:off,canSignIn:!remoteHost})}${pageTabsMarkup(tab)}<div class="pip-page-body" data-page="${tab}">${body}</div></div>`;
}
// What it may do without asking (an Always allow you gave): only shown when there is one, and each
// can be taken back here, as its Allow card promises.
// The line under a grant's label: the account it runs on; for the grants of 15 Nov (a careful card's, the floor's, a
// payment's: their tool starts CARRY, FLOOR or PAY), where it applies in plain words, never the tool or "browser".
function grantWhere(x,inline=false){
 const tool=String(x.tool||''),terminal=x.account==='terminal'||x.server==='Terminal';
 const words=tool.startsWith('CARRY ')?`Careful mode · its ${terminal?'Terminal':'browser'}`:tool.startsWith('FLOOR ')?'Its Terminal':tool.startsWith('PAY ')?'A payment · its browser'
  :x.account==='connection_managed'?'The account its connection uses':inline?`account ${x.account}`:x.account;
 return inline?words.charAt(0).toLowerCase()+words.slice(1):words;
}
function allowedMarkup(){
 if(S.apiVersion<41)return '';
 if(grantsState.pip!==S.selected){void loadGrants();return '';}
 const grants=grantsState.value?.grants||[];if(!grants.length)return '';
 const off=S.busy||!usable();
 return `<section class="pip-page-group" aria-label="Allowed without asking"><h3 class="pip-page-label">Allowed without asking</h3><ul class="pip-page-list">${grants.map(x=>`<li class="pip-page-row static"><span class="row-words"><span>${esc(x.label)}</span><small>${esc(grantWhere(x))}</small></span><button type="button" class="quiet pill" data-revoke-grant="${esc(x.id)}"${off?' disabled':''}>Stop allowing</button></li>`).join('')}</ul></section>`;
}
function pipPageMenu(){
 const p=S.pip,off=S.busy||!usable();
 return `${personalPip()?'':runNowMenuRow()}<button type="button" data-tab="runs">${reportsName()}</button>${S.apiVersion>=14&&!(S.apiVersion>=44&&personalPip())?'<button type="button" data-tab="memory">Memory</button>':''}<hr>`
  +'<button type="button" data-copy-pip-id>Copy ID</button>'
  +(archived()?'':`<button type="button" id="toggle-pip"${off||S.apiVersion>=16&&!canLifecycle()?' disabled':''}>${p.status==='paused'?'Resume':'Pause'}</button>`)
  +(S.apiVersion>=16&&canLifecycle()?(archived()?`<button type="button" id="restore-pip"${off?' disabled':''}>Restore…</button>${S.apiVersion>=68?`<button type="button" id="delete-archived-pip-menu" class="danger-text"${off?' disabled':''}>Delete permanently…</button>`:''}`:`<button type="button" id="archive-pip" class="danger-text"${off?' disabled':''}>Archive…</button>`):'');
}
// Settings for all your Pips (from the Pips home): their computers, and the apps they use.
async function loadPipsSettings(){
 if(remoteHost||S.apiVersion<43||!usable())return;
 const token=S.epoch,sequence=++pipsSettings.seq,view=pipsSettings.view;
 try{if(view==='webhooks'&&webhookRoutines()){const value=webhookReach(await send('get_webhook_reach'));if(token!==S.epoch||sequence!==pipsSettings.seq)return;pipsSettings.reach=value;pipsSettings.reachError='';}
  else if(view==='plugins'){const uses=pluginUsesPage(await send('list_pip_plugin_uses'));if(token!==S.epoch||sequence!==pipsSettings.seq)return;pipsSettings.plugins=uses;pipsSettings.pluginsError='';}
  else if(view==='apps'){const [listed]=await Promise.all([send('list_pip_apps'),loadOwnApps()]);const apps=appsPage(listed);if(token!==S.epoch||sequence!==pipsSettings.seq)return;pipsSettings.apps=apps;pipsSettings.appsError='';
   if(S.apiVersion>=44){const v=await send('get_pips_limit');if(token===S.epoch&&record(v)&&Number.isSafeInteger(v.max_pips)){pipsSettings.limit=v;if(draft.pipsMax==='')draft.pipsMax=String(v.max_pips);}}}
  else{const value=computersPage(await send('get_pip_computers'));if(token!==S.epoch||sequence!==pipsSettings.seq)return;pipsSettings.computers=value;pipsSettings.computersError='';
   if(value.setup.state==='running'||value.computers.some(c=>c.resetting))window.setTimeout(()=>{if(pipsSettings.view==='computer'&&!disposed)void loadPipsSettings();},3000);}}
 catch(error){if(token===S.epoch&&sequence===pipsSettings.seq){if(view==='webhooks')pipsSettings.reachError=errorText(error);else if(view==='models')pipsSettings.backupError=errorText(error);else if(view==='plugins')pipsSettings.pluginsError=errorText(error);else if(view==='apps')pipsSettings.appsError=errorText(error);else pipsSettings.computersError=errorText(error);}}
 finally{if(token===S.epoch)render();}
}
// A Pip's fallback model (API 76; D14): chosen with the ⋯ beside a model in its model picker. When its own model doesn't
// answer (a usage limit, unreachable, signed out), its turn carries on with it, says so once, and its prompt box says the
// fallback is answering until its own model is back. One provider and one model; never a subscription or the Router.
const pipBackupState={pip:'',value:null,error:'',busy:false,seq:0};
async function loadPipBackup(){
 if(S.apiVersion<76||remoteHost||!usable()||!S.selected)return;
 const token=scope(),pip=S.selected,sequence=++pipBackupState.seq;
 try{const value=pipBackup((await send('get_pip_backup',{pip_id:pip})).backup,pip);if(token!==scope()||sequence!==pipBackupState.seq||S.selected!==pip)return;
  pipBackupState.pip=pip;pipBackupState.value=value;pipBackupState.error='';render();}
 catch(error){if(token===scope()&&sequence===pipBackupState.seq){pipBackupState.error=errorText(error);render();}}
}
// D14: a fallback's row value both ways. A model DGC runs (its connection or a saved provider), Claude Code or Codex
// (9 Nov), or DGC Router (any system, or one system's model); Default follows, so it is never one.
const fallbackValue=v=>!v?'':v.engine?`subscription:${v.engine}${v.model?':'+v.model:''}`:v.router?(v.model?`router:${v.model}`:'router')
 :v.model?(v.provider?`provider:${v.provider}:${v.model}`:`model:${v.model}`):'';
const fallbackChoice=value=>{const m=/^provider:(provider_[a-f0-9]{32}):(.+)$/.exec(value),sub=/^subscription:(claude|codex)(?::(.+))?$/.exec(value);
 return m?{provider:m[1],model:m[2]}:sub?{engine:sub[1],model:sub[2]||''}:value==='router'?{router:true,model:''}
  :value.startsWith('router:')?{router:true,model:value.slice(7)}:value.startsWith('model:')?{provider:'',model:value.slice(6)}:null;};
const pipFallback=()=>S.apiVersion>=76&&!remoteHost&&pipBackupState.pip===S.selected?pipBackupState.value:null;
async function setPipBackup(choice){
 if(pipBackupState.busy||!usable()||S.apiVersion<76)return;const token=scope(),pip=S.selected,name=S.pip?.name||'It';pipBackupState.busy=true;pipBackupState.seq++;S.fallbackMenu='';render();
 try{const value=pipBackup((await send('set_pip_backup',{pip_id:pip,model:choice?.model||'',provider:choice?.provider||'',...(choice?.engine?{engine:choice.engine}:{}),...(choice?.router?{router:true}:{})})).backup,pip);if(token!==scope()||S.selected!==pip)return;pipBackupState.pip=pip;pipBackupState.value=value;pipBackupState.error='';
  const set=!!(value.model||value.engine||value.router),shown=value.engine?modelLabel({mode:'subscription',engine:value.engine,model:value.model}):value.router?(value.model||'DGC Router'):value.model;
  if(!set)S.fallbackOn=null;
  S.notice=set?`${name} carries on with ${shown} when its own model doesn\u2019t answer.`:`${name} has no fallback model: it stops when its model doesn\u2019t answer.`;}
 catch(error){if(token===scope()){pipBackupState.error=errorText(error);S.notice=pipBackupState.error;}}
 finally{pipBackupState.busy=false;if(token===scope())render();}
}
async function pipsSettingsCall(command,args,notice){
 if(pipsSettings.busy||!usable())return;const token=S.epoch;pipsSettings.busy=true;render();
 try{const result=await send(command,args);if(token!==S.epoch)return;S.notice=typeof notice==='function'?notice(result):notice;pipsSettings.confirmReset='';await loadPipsSettings();}
 catch(error){if(token===S.epoch){if(pipsSettings.view==='models')pipsSettings.backupError=errorText(error);else if(pipsSettings.view==='plugins')pipsSettings.pluginsError=errorText(error);else if(pipsSettings.view==='apps')pipsSettings.appsError=errorText(error);else pipsSettings.computersError=errorText(error);}}
 finally{pipsSettings.busy=false;if(token===S.epoch)render();}
}
function pipsSettingsMarkup(){
 const view=['apps','plugins','webhooks'].includes(pipsSettings.view)&&(pipsSettings.view!=='plugins'||S.apiVersion>=44)&&(pipsSettings.view!=='webhooks'||webhookRoutines())?pipsSettings.view:'computer',busy=pipsSettings.busy||S.busy||!usable();
 const tabs=`<nav class="pip-page-tabs" aria-label="Pips settings">${[['computer','Computer'],['apps','Apps'],...(S.apiVersion>=44?[['plugins','Plugins']]:[]),...(webhookRoutines()?[['webhooks','Webhooks']]:[])].map(([k,l])=>`<button type="button" class="seg" data-pips-settings="${k}" aria-pressed="${view===k}">${l}</button>`).join('')}</nav>`;
 const body=view==='webhooks'?reachMarkup(pipsSettings.reach,{esc,busy:pipsSettings.reachBusy,off:busy,error:pipsSettings.reachError,refusal:pipsSettings.reachRefusal,ownBase:draft.hookOwnBase,formatDate:shortDate})
  :view==='plugins'?pluginUsesMarkup(pipsSettings.plugins,{esc,busy,error:pipsSettings.pluginsError}):view==='apps'?ownAppsMarkup(S.apiVersion>=61?S.ownApps:[],{esc,busy,error:S.apiVersion>=61?S.ownAppsError:''})+appsSettingsMarkup(pipsSettings.apps,{esc,busy,error:pipsSettings.appsError,ownApps:S.apiVersion>=61&&(S.ownApps||[]).length>0})+(S.apiVersion>=43&&!remoteHost?`<section class="pip-page-group"><div class="pip-page-row static"><span class="row-words"><strong>Skills</strong><small>Your Pips use your DGC skills that fit everyday work: deep research, charts and planning, and the ones you add. A skill is instructions; it never gives a Pip new access.</small></span>${button('manage-skills','Manage skills…',false,'quiet pill')}</div></section>`:'')+(S.apiVersion>=44&&!remoteHost&&pipsSettings.limit?`<section class="pip-page-group"><form id="pips-limit-form" class="pip-page-row static"><span class="row-words"><label for="pipsMax"><strong>How many Pips you can have</strong></label><small>${pipsSettings.limit.default.toLocaleString('en-US')} unless you choose another number, up to ${pipsSettings.limit.maximum.toLocaleString('en-US')}. Archived Pips don’t count. A powerful computer can run thousands.</small></span><input id="pipsMax" data-draft="pipsMax" type="number" min="1" max="${pipsSettings.limit.maximum}" step="1" inputmode="numeric" value="${esc(draft.pipsMax)}" aria-label="How many Pips you can have"><button type="submit" class="quiet pill"${busy||String(pipsSettings.limit.max_pips)===draft.pipsMax?' disabled':''}>Save</button></form></section>`:'')+payTotalSection()
  :computersMarkup(pipsSettings.computers,{esc,busy,error:pipsSettings.computersError,formatDate:shortDate,confirming:pipsSettings.confirmReset});
 return `<header class="pip-topbar"><button type="button" id="pips-settings-close" class="topbar-icon" aria-label="Your Pips" title="Your Pips">${simpleIcon('back')}</button><div class="pip-pill settings-pill"><span>Pips settings</span></div><span></span></header><div class="simple-content"><div class="pip-page">${tabs}<div class="pip-page-body">${body}</div>${howPipsWorkLine()}</div></div>`;
}
// Pips settings › How Pips work now (0.52, Pips API 96): opens "Your Pips moved into one list" again. The pop-up is the
// side bar's (media/shared/pipswelcome.js), so the line is here only where the page gave a way to open it.
function howPipsWorkLine(){return S.apiVersion>=FLOW_API&&!remoteHost&&typeof options.onHowPipsWork==='function'?`<p class="pips-how-line"><button type="button" id="pips-how" class="link hook-link">How Pips work now</button><span> What changed for your Pips in 0.52.</span></p>`:'';}
async function appLinkAction(type,id,quiet=false,fields={}){
 if(!usable()||!personalPip()||(appLinkBusy&&!quiet))return;
 const token=scope(),pip=S.selected;if(!quiet){appLinkBusy=id;render();}
 try{
  const answer=appLinkResult(await send(type,{pip_id:pip,link_id:id,...fields}),pip,id);if(token!==scope()||S.selected!==pip)return;
  putAppLink(answer.link);if(answer.host)appLinkHosts.set(id,answer.host);
  if(answer.accounts)appLinkChoices.set(id,{accounts:answer.accounts,wanted:answer.wanted});
  if(type==='start_pip_app_link'&&answer.link.status==='authorizing'){appLinkUntil=Date.now()+5*60*1000;if(!answer.opened)S.notice='DGC could not open your browser. Choose Open sign-in again.';}
  if(answer.link.status==='connected'){appLinkChoices.delete(id);appLinkSettled.add(id);void loadMessages();}
  if(answer.link.status==='connected'||type==='disconnect_pip_app_link')void loadAppsUse();
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
 const summary=(S.emailDrafts||[]).find(x=>x.id===id),d=summary&&draftDetails.get(summary.id+':'+summary.digest),links=connectedLinks('gmail'),link=pickedLink(id,links);
 if(!d||d.status!=='pending'||d.expired||!usable()||allowBusy)return;
 if(!links.length){void openEmailDraft(id);return;}
 if(!link)return;   // several addresses and none picked: nothing is chosen for you
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
  const result=await send(always?'always_allow_pip_app_action':'accept_pip_app_action',{action_id:action.id,expected_digest:action.digest});
  if(token!==scope())return;
  const outcome=messageReview(result.action,pip,S.workspace.id);
  if(outcome.id!==action.id||outcome.digest!==action.digest)throw Error('The send receipt does not match this saved review. Refresh to see it.');
  cardEdits.delete(id);
  S.notice=outcome.status==='succeeded'?(changed?'Sent with your changes. Gmail accepted it; delivery is not confirmed.':'Sent, exactly as shown. Gmail accepted it; delivery is not confirmed.')
   :'The email is unconfirmed. Check Gmail Sent before sending it again; DGC will not retry.';
  if(always&&result.grant)S.notice+=` ${S.pip?.name||'This Pip'} may now send emails from ${link.label||'this account'} without asking; take it back in its Settings.`;
  void loadEmailDrafts();
 }catch(error){if(token===scope()){if(edit)cardError(edit,error);else setError(error);}}
 finally{if(token===scope()){allowBusy='';render();}}
}
// Add on a calendar card: the same steps as Send, for the Pip's connected Google Calendar.
async function allowCreate(id,always=false){
 const summary=(S.calendarDrafts||[]).find(x=>x.id===id),d=summary&&draftDetails.get(summary.id+':'+summary.digest),links=connectedLinks('googlecalendar'),link=pickedLink(id,links);
 if(!d||d.status!=='pending'||d.expired||!usable()||allowBusy)return;
 if(!links.length){void openEmailDraft(id);return;}
 if(!link)return;
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
  const result=await send(always?'always_allow_pip_app_action':'accept_pip_app_action',{action_id:action.id,expected_digest:action.digest});
  if(token!==scope())return;
  const outcome=messageReview(result.action,pip,S.workspace.id);
  if(outcome.id!==action.id||outcome.digest!==action.digest)throw Error('The calendar receipt does not match this saved review. Refresh to see it.');
  cardEdits.delete(id);
  S.notice=outcome.status==='succeeded'?(changed?'Added with your changes.':'Added, exactly as shown.')+(event.send_invitations?' Invitations were requested; delivery is not confirmed.':'')
   :'The calendar event is unconfirmed. Check the calendar before adding it again; DGC will not retry.';
  if(always&&result.grant)S.notice+=` ${S.pip?.name||'This Pip'} may now add events to ${link.label||'this calendar'} without asking; take it back in its Settings.`;
  void loadEmailDrafts(true);
 }catch(error){if(token===scope()){if(edit)cardError(edit,error);else setError(error);}}
 finally{if(token===scope()){allowBusy='';render();}}
}
// Editing a card: the fields as typed, per draft version. A new version from the Pip starts fresh.
const cardEdits=new Map();
function cardEdit(d){const e=d&&cardEdits.get(d.id);return e&&e.digest===d.digest?e:null;}
function cardError(edit,error){if(edit){edit.error=errorText(error);render();}else setError(error);}
// The Pip's addresses for an app. With one, a card uses it; with two or more, the one picked on that card's own menu,
// and none until then (pips-09: nothing picks a default).
const allowFrom=new Map();let allowFromOpen='';
function connectedLinks(toolkit){return (S.appLinks||[]).filter(l=>l.status==='connected'&&l.toolkit===toolkit);}
function pickedLink(id,links){return links.length>1?links.find(l=>l.account===allowFrom.get(id))||null:links[0]||null;}
function closeAllowFrom(focus=false){const id=allowFromOpen;if(!id)return;allowFromOpen='';render();if(focus)document.querySelector(`[data-allow-from="${id}"]`)?.focus();}
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
function openReview(review) {
  // A dialog opened from Controls: that popover's menu stacked over it and hid its title (Stop all Pips, seen in testing).
  const controls=document.querySelector('details.runner-controls[open]'),fromControls=!!controls&&controls.contains(document.activeElement);
  controls?.removeAttribute('open');
  dialogReturn=fromControls?{id:'runner-controls-toggle',data:{}}:{id:document.activeElement?.id||'',data:{...document.activeElement?.dataset}}; S.review={...review,scope:scope(),request:JSON.parse(JSON.stringify(review.request)),error:''}; render(); renderReview(); }
const reviewBlocked=r=>!!r.blocked || (r.setup&&(S.apiVersion<23||r.setup.pip_type==='pulse'&&S.apiVersion<27)) || (r.requiresCommitPaths&&S.apiVersion<22) || (r.requiresPulsePlan&&S.apiVersion<21) || (r.requiresQuillAutomation&&S.apiVersion<20) || (r.requiresSessionTurn&&S.apiVersion<18) || (r.commandOutcome&&S.apiVersion<17) || (r.requiresSpecialists&&S.apiVersion<15) || (r.requiresExecution&&S.executionCapability?.available!==true) || (r.expiresAt && Number.isFinite(Date.parse(r.expiresAt)) && Date.parse(r.expiresAt)<=Date.now());
function renderReview() {
  const r=S.review;if(!r)return;
  $('app').inert=true;
  if(r.loginForm){renderLoginForm(r);return;}
  // (Drawn again while it is open, as its words change: it does not arrive a second time, media/shared/dialog.css.)
  $('review-root').innerHTML=`<div class="overlay dgc-scrim${$('review-root').querySelector('.dialog:not(.login-dialog)')?' dgc-still':''}"><section class="dialog dgc-dialog${r.pinned?' is-pinned':''}" role="dialog" aria-modal="true" aria-labelledby="review-title"><h2 id="review-title" tabindex="-1">${esc(r.title)}</h2><p>${esc(r.description)}</p>${r.body||''}${r.permanentPip?`<label>Type ${esc(S.pip?.name||'the Pip name')} to confirm<input id="deletePipName" data-draft="deletePipName" value="${esc(draft.deletePipName)}" autocomplete="off"${S.busy?' disabled':''}></label>`:''}${r.reasonRequired&&r.note?`<label>${esc(r.note)}<textarea id="findingReviewReason" data-draft="findingReviewReason"${S.busy?' disabled':''}>${esc(draft.findingReviewReason)}</textarea></label>`:''}${r.memoryRecord?`<label>Optional expiry, with time zone<input id="memoryExpiry" data-draft="memoryExpiry" value="${esc(draft.memoryExpiry)}" placeholder="2026-12-01T09:00:00Z"${S.busy?' disabled':''}></label><p class="muted">Leave empty for no automatic expiry. The source and job scope stay explicit.</p>`:''}${errorMarkup(r.error)}<div class="actions">${r.secondary?button(r.secondary.id,r.secondary.label,S.busy||!usable(),'secondary-action'):''}${button('review-cancel',r.readOnly?'Close':'Cancel',S.busy)}${r.always&&!r.readOnly&&S.apiVersion>=41?button('review-always','Always allow',S.busy||!usable()||reviewBlocked(r)):''}${r.readOnly?'':button('review-confirm',S.busy?(r.working||'Applying…'):r.confirm,S.busy||!usable()||reviewBlocked(r),r.danger?'danger':'primary')}</div></section></div>`;
  if(r.connectorSummary)mountConnectorSummary($('connector-review-values'),r.connectorSummary);
  if(r.connectorForm){
    const form=r.connectorForm,select=$('connector-tool');select.value=String(form.selected);select.disabled=S.busy;
    const mount=()=>{$('connector-description').textContent=form.inspection.tools[form.selected].description;mountConnectorInputs($('connector-fields'),form.inputs[form.selected],S.busy);};
    select.addEventListener('change',()=>{const index=Number(select.value);if(Number.isSafeInteger(index)&&form.inspection.tools[index]){form.selected=index;mount();}});mount();
  }
  $('review-title')?.focus({preventScroll:true});document.querySelector('[role=dialog]')?.scrollTo?.(0,0);
  picker.restore();
}
function clearSelection() { resetProjects();resetOwner();resetGoal();resetPay();resetSent();knowsState.pip='';knowsState.busy=false;knowsState.error='';S.pipKeys=[];S.pipKeysError='';pipKeysSeq++;pipKeyBusy='';pipKeyConfirm='';pipKeyFilled.clear();pipKeyErrors.clear();pipKeyDone.clear();pipKeyTicked.clear();S.keyRequests=[];keyFilled.clear();keyErrors.clear();keySaved.clear();S.notes=null;S.notesPip='';S.notesError='';notesSeq++;noteConfirmAll=false;draft.noteAdd='';S.workingNotes=null;S.workingNotesPip='';S.workingNotesError='';workingNotesSeq++;workingNotesEditing=false;draft.workingNotesText='';S.dailyLog=null;S.dailyLogPip='';S.dailyLogError='';dailyLogSeq++;S.appLinks=[];S.appLinksError='';skillsUse.pip='';skillsUse.asked='';skillsUse.value=null;skillsUse.error='';skillsUse.busy=false;skillsUse.seq++;folderUi.open=false;folderUi.adding=false;folderUi.error='';folderUi.busy=false;appsUse.pip='';appsUse.asked='';appsUse.value=null;appsUse.error='';appsUse.busy=false;appsUse.confirm='';appsUse.seq++;allowFrom.clear();allowFromOpen='';S.plugins=[];S.pluginsInstalled=[];S.pluginsError='';pluginSeq++;pluginBusy='';S.routines=null;S.routinesError='';routineSeq++;routineEditing='';routineError='';S.pipPage='info';S.legacyOpen=false;pageNameDirty=false;lookDirty=false;shared.pip='';shared.seq++;window.clearTimeout(appLinkTimer);appLinkBusy=''; S.editingGoal=false;S.quickDirty=false;connectorDraftSeq++;S.connectorDrafts=[];S.connectorDraftError=""; calendarDraftSeq++;S.calendarDrafts=[];S.calendarDraftError="";emailDraftSeq++;S.emailDrafts=[];S.emailDraftError=""; chatActivities.clear(); S.composerPanel='';S.chatControls=null;S.continuity=null; statementSeq++;statementAnchorSeq++;statementRows=[];statementPage=null;statementLoaded=false;statementLoading=false;statementError='';statementInspecting=false;statementRetry=null;draft.statementKind='fact';draft.statementTitle='';draft.statementText='';draft.statementReason='';draft.statementExpiry='';draft.statementSource=''; memorySeq++;memorySourceSeq++;memories=[];memoryCursor=null;memoryLoaded=false;memoryLoading=false;memoryError='';draft.memoryExpiry='';resetOutcomes(); S.sourceDirty=false;S.sourceDraftVersion=null;draft.sourceReason=''; adaptationSeq++;S.adaptations=[];S.adaptationCursor=null;S.adaptationsLoaded=false;S.adaptationsLoading=false;S.adaptationsError='';S.adaptationDirty=false;S.adaptationDraftVersion=null;draft.adaptationReason='';handoffSeq++;handoffDetailSeq++;S.handoffs=[];S.handoffCursor=null;S.handoffsLoaded=false;S.handoffsLoading=false;S.handoffsError='';S.handoffDraft=null;checkpointSeq++;S.checkpoints=[];S.checkpointCursor=null;S.checkpointsLoaded=false;S.checkpointsLoading=false;S.checkpointsError='';draft.findingReviewReason='';selectionGeneration++;if(S.selected)chatDrafts.set(S.selected,draft.chatText);postsSeq++;S.posts=[];S.postsCursor=null;S.postsPip='';S.postsLoaded=false;S.fixes=new Map();S.fixesPip='';fixesSeq++;S.postsLoading=false;S.postsError='';messageSeq++;streamSeq++;streamLoading=false;S.stream=null;S.messages=[];S.messageCursor=null;S.messagesLoaded=false;S.messagesLoading=false;S.messagesError='';S.chatActiveRun=null;S.chatWaiting=[];S.routineNotes=[];S.omitted=0;S.modelDirty=false;draft.modelReason='';S.busy=false;approvalSeq++;S.approvals=[];S.approvalCursor=null;S.approvalsLoaded=false;S.approvalsLoading=false;S.approvalsError='';S.scheduleDirty=false;S.scheduleDraftVersion=null;draft.scheduleReason=''; activitySeq++;S.activity=null;S.activityLoading=false;S.activityError=''; dropLive(); selectionSeq++;detailSeq++;historySeq++;S.pip=null;S.runs=[];S.run=null;S.runId='';S.versions=[];S.cursor=null;S.historyLoaded=false;draft.revisionGoal='';draft.revisionReason='';closeReview(); }
// "Report ready", "Last run failed": the Pip page's status names its latest run, so it opens that run (reported
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
    S.pip=p.pip;S.runs=r.runs;syncLive();if(p.pip?.model_choice?.mode==='provider'&&S.apiVersion>=74&&!Array.isArray(S.providers)&&!S.modelsLoading)void loadModels();if(!S.modelDirty)draft.pipModel=modelValue(p.pip.model_choice);if(!S.scheduleDirty)hydrateSchedule(p.pip);if(!S.quickDirty)hydrateQuickSchedule(p.pip);if(!S.adaptationDirty)hydrateAdaptation(p.pip);if(!S.sourceDirty)hydrateSource(p.pip);if(!draft.revisionGoal)draft.revisionGoal=p.pip.goal;render();void loadPosts();
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
  if(!usable()||!S.workspace)return;const token=scope(),epoch=S.epoch,sequence=++refreshSeq;S.refreshing=true;void loadSetups();void loadAttention();void loadUnread();
  // The dropdown's folders, and (while it shows) the list of every project's Pips, are read again with the rest.
  if(onePips())void loadOne();
  if((typeof S.projectFolder==='string'||onePips())&&S.folders){void loadFolders().then(changed=>{if(changed){void loadAttention();render();}});if(S.projectEmpty&&foldersOn()&&!chosenFolder())void loadProjectsAll();}
  try {
    const paged=pipsPaged();
    const results=await Promise.allSettled([send('list_pips',{workspace_id:S.workspace.id,...(paged?{order:'recent',limit:100,...(S.pipSearch?{query:S.pipSearch}:{})}:{})}),send('get_pip_runner'),...(includeContext?[send('get_workspace_context',{workspace_id:S.workspace.id})]:[])]);
    if(token!==scope())return;
    if(results[0].status==='fulfilled'){const jobs=results[0].value.pips;if(!Array.isArray(jobs)||!jobs.every(p=>p.workspace_id===S.workspace.id))throw new Error('Pips list does not match this workspace.');S.jobs=(paged?mergePage(jobs,results[0].value):jobs).map(pipFresh);S.jobsRead=true;}else S.error=errorText(results[0].reason);
    if(results[1].status==='fulfilled'){S.runner=null;S.runner=runner(results[1].value.runner);}else{S.runner=null;S.error=errorText(results[1].reason);}
    if(includeContext){if(results[2].status==='fulfilled'){S.context=null;S.context=context(results[2].value.context,S.workspace.id);}else{S.context=null;S.error=errorText(results[2].reason);}}
    if(S.selected&&!S.jobs.some(p=>p.id===S.selected)&&paged&&S.pip?.id===S.selected)S.jobs=[...S.jobs,S.pip];
    if(S.selected&&!S.jobs.some(p=>p.id===S.selected)){clearSelection();S.selected='';}
    if(restoreView&&!S.create){restoreView=false;if(savedView?.workspace_id===S.workspace.id&&S.apiVersion>=79){if(record(savedView.conversations))for(const [id,conv] of Object.entries(savedView.conversations).slice(-20))if(/^conv_[0-9a-f]{32}$/.test(conv))convShown.set(id,conv);if(record(savedView.conversation_drafts))for(const [key,text] of Object.entries(savedView.conversation_drafts).slice(-40))if(typeof text==='string'&&text.length<=65536)convDrafts.set(key,text);}if(savedView?.workspace_id===S.workspace.id&&record(savedView.drafts))for(const [id,text] of Object.entries(savedView.drafts).slice(-20))if(typeof text==='string'&&text.length<=65536)chatDrafts.set(id,text);if(savedView?.workspace_id===S.workspace.id&&record(savedView.draft_marks))for(const [id,kept] of Object.entries(savedView.draft_marks).slice(-20)){const fine=record(kept)&&typeof kept.text==='string'&&Array.isArray(kept.parts)&&kept.parts.length<=256&&kept.parts.every(p=>typeof p==='string'||record(p)&&['plugin','pip','file'].includes(p.kind)&&typeof p.label==='string'&&typeof p.wire==='string'&&typeof p.identity==='string'&&p.label.length<=4096&&p.wire.length<=4096&&p.identity.length<=128)&&kept.parts.map(p=>typeof p==='string'?p:p.wire).join('')===kept.text;if(fine)chatMarks.set(id,kept);}if(savedView?.workspace_id===S.workspace.id&&record(savedView.chat_queues))for(const [id,list] of Object.entries(savedView.chat_queues).slice(-20))if(Array.isArray(list))chatQueues.set(id,list.filter(item=>record(item)&&typeof item.id==='string'&&typeof item.text==='string'&&item.text.length<=4000).slice(0,MAX_CHAT_QUEUE));if(savedView?.workspace_id===S.workspace.id&&!savedView.overview&&!(navigationPending&&options.navigation?.overview===true)&&S.jobs.some(p=>p.id===savedView.selected))await select(savedView.selected);}if(S.selected)await loadSelected(false);
  }catch(error){if(token===scope())S.error=errorText(error);}
  finally{if(epoch===S.epoch&&sequence===refreshSeq){S.refreshing=false;render();if(S.apiVersion>=72&&(!S.selected||S.overview)&&!S.create&&(!flowState.loaded||flowState.workspace!==S.workspace.id||Date.now()-flowState.loadedAt>15000))void loadFlows();}}
}
async function initialize() {
  const epoch=S.epoch;S.loading=true;render();
  try {const [result,catalog]=await Promise.all([send('list_workspaces'),send('list_pip_types'),loadFolders()]);if(epoch!==S.epoch)return;S.types=pipTypes(catalog);S.workspaces=result.workspaces||[];S.currentWorkspaceId=typeof result.current_workspace_id==='string'?result.current_workspace_id:null;S.projectEmpty=false;S.switching=false;const personalHome=S.apiVersion>=43&&!remoteHost?result.workspaces?.find(w=>w.kind==='personal')?.id:null;let workspace;
   if(!options.workspaceId&&scopeTabs()){
    // The tab chosen last in this window; else Personal (Pips API 43), else this folder's project. Only ever these two.
    const personal=personalSpace(),project=projectSpace(),saved=record(savedView)?savedView:{};
    const wantsProject=saved.scope_tab==='project'||!!project&&saved.workspace_id===project.id;
    workspace=wantsProject?project||personal:saved.workspace_id===personal.id||personalHome?personal:project||personal;
    S.projectEmpty=wantsProject&&!project;
   }else workspace=result.workspaces?.find(w=>w.id===(options.workspaceId||(savedView?.workspace_id&&result.workspaces.some(w=>w.id===savedView.workspace_id&&w.kind==='personal')?savedView.workspace_id:personalHome||result.current_workspace_id)));
   if(!workspace)throw new Error('DGC could not resolve the selected registered workspace.');S.workspace=workspace;S.loading=false;
   // One Pips: the filter chosen last in this window; and a Pip of a folder that was open is opened again in its project.
   const left=onePips()&&record(savedView)&&!savedView.overview&&typeof savedView.selected==='string'&&/^pip_[a-f0-9]{32}$/.test(savedView.selected)&&savedView.workspace_id!==workspace.id?savedView.selected:'';
   if(onePips())one.filter=savedFilter(record(savedView)?savedView.pips_filter:'',S.folders||[]);
   await refresh(true);if(epoch===S.epoch&&navigationPending){navigationPending=false;await navigateFromHost(options.navigation);}
   else if(epoch===S.epoch&&left)await navigateFromHost({pip:left}).catch(()=>{});}
  catch(error){if(epoch===S.epoch){S.loading=false;setError(error);}}
}
// (While it goes somewhere, the Project tab is not put back on the Project Folder choice: settleProjectTab waits.)
let navigating=0;
async function navigateFromHost(value){navigating++;try{return await navigateFromHostNow(value);}finally{navigating--;if(!navigating&&foldersOn())render();}}
async function navigateFromHostNow(value) {
  if(!record(value))return;
  if(value.overview===true){if(S.selected)chatDrafts.set(S.selected,draft.chatText);S.overview=true;S.tab='chat';rememberView();render();return;}
  // The dock's "+" > New Personal Pip: Your Pips, with New Pip open on a name and a character.
  if(value.create==='personal'||value.create==='pip'&&onePips()){
   const personal=personalSpace();
   if(personal&&S.workspace?.id!==personal.id)await enterWorkspace(personal);
   if(S.selected)chatDrafts.set(S.selected,draft.chatText);S.projectEmpty=false;S.overview=true;S.tab='chat';rememberView();render();
   // (One Pips: the one New Pip, its folder line pre-filled with the folder it was asked for from, a Work session's.)
   if(onePips())openNewPip(typeof value.folder==='string'?value.folder:'');
   else if(!projectHome())openNewPip();
   return;
  }
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
   // so far, or another workspace's: a project's Pip while Personal shows (reported 2026-10-18, saw only Core and
   // "not available in the selected workspace"). Read it, open its own workspace, then it. One that is gone says so
   // (get_pip: "That Pip isn’t on this computer").
   const found=(await send('get_pip',{pip_id:value.pip})).pip;
   if(!record(found)||found.id!==value.pip||typeof found.workspace_id!=='string')throw Error('That Pip isn’t on this computer any more. It may have been deleted.');
   if(found.workspace_id!==S.workspace.id){
    // Only Personal and this folder's project (reported 2026-10-21): another project's Pip is not opened here. With
    // the Project Folder dropdown (12 Nov) a Project Pip of any folder opens here (openableSpaces).
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
  // The Work chat's chip for a running Pip opens its chat at the run's live post (or its post, if it has ended).
  if(tab==='chat'&&typeof value.run==='string'&&/^run_[0-9a-f]{32}$/.test(value.run)){await jumpToRun(value.run);return;}
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
async function mutate(request,after,told) {
  if(S.busy||!usable())return;if(archived()&&['propose_pip_update','accept_pip_update','reject_pip_update','propose_pip_handoff','propose_pip_artifact_handoff','accept_pip_handoff','pause_pip','resume_pip','run_pip','send_pip_message','record_pip_statement'].includes(request.type)){setError(`${S.pip?.name||'This Pip'} is archived. Restore it in Settings first.`);return;}const token=scope();S.busy=true;S.error='';render();if(S.review)renderReview();
  try{const result=await broker.request(request);if(token!==scope()||!usable())return;closeReview();await after?.(result);if(token===scope())await refresh(true);}
  catch(error){if(token===scope()){if(told)told(errorText(error));else if(S.review){S.review.error=errorText(error);renderReview();}else S.error=errorText(error);}}
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
 return `<dl class="meta"><dt>Name</dt><dd>${esc(proposal.definition?.name)}</dd><dt>What it does</dt><dd>${esc(proposal.definition?.goal)}</dd><dt>Model</dt><dd>${esc(modelLabel(proposal.definition?.model_choice))}</dd><dt>Schedule</dt><dd>${esc(scheduleLabel(proposal.definition?.schedule))}</dd></dl>${JSON.stringify(S.pip.app_plan||null)!==JSON.stringify(plan||null)?`<h3>Reads now</h3>${readList(S.pip.app_plan)}<h3>Reads after this change</h3>${readList(plan)}<p class="muted">This lets it read only. What it reads goes to ${esc(modelLabel(proposal.definition?.model_choice)==='Default'?'its model':modelLabel(proposal.definition?.model_choice))}. Removing access stops future reads; what it already read can’t be taken back.</p>`:''}${webChanged?`<h3>Current web reads</h3>${webList(S.pip.web_plan)}<h3>Proposed web reads</h3>${webList(web)}<p class="muted">DGC reads exactly these public pages and searches before each run.${S.pip.computer_plan||proposal.definition?.computer_plan?'':' Without a computer, it can’t open other pages, follow links, sign in or fill in forms.'}</p>`:''}<p>${esc(proposal.reason)}</p>`;
}
function readList(plan){const words=appReadWords(plan);return words.length?`<ul class="web-reads">${words.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>`:'<p class="muted">None</p>';}
function proposalReview(id,reject=false) {
  const proposal=S.pip?.proposals?.find(p=>p.id===id);if(!proposal)return;
  openReview(proposalReviewSpec(proposal,reject));
}
// Allow on a change's card: the request the review page sends (the proposal's own expected version), refused when the
// page would refuse it (written for an older version, expired, set aside, or not supported here), with what went
// wrong said in the card. Nothing is opened first; the page is still there, from the card's Details.
async function allowChange(id){
  const proposal=S.pip?.proposals?.find(p=>p.id===id);if(!proposal||S.busy||!usable())return;
  const review=proposalReviewSpec(proposal,false);
  if(reviewBlocked(review)){changeErrors.set(id,proposal.expected_version!==S.pip.current_version?STALE_CHANGE:'This expired or was changed. Refresh and try again.');render();return;}
  changeErrors.delete(id);S.changeAllowing=id;
  try{await mutate(JSON.parse(JSON.stringify(review.request)),result=>updateDecided(review,result),error=>{changeErrors.set(id,error);});}
  finally{S.changeAllowing='';}
}
/** After a change was accepted or turned down, from its review page or its card: the drafts it settles, and the notice. */
function updateDecided(review,result){
  const type=review.request.type;
  if(type==='accept_pip_update'){S.adaptationDirty=false;draft.adaptationReason='';S.scheduleDirty=false;S.modelDirty=false;draft.modelReason='';draft.scheduleReason='';}
  if(S.approvalsLoaded)void loadApprovals();
  const named=S.pip?.name||'This Pip',aside=review.setsAside?` ${review.setsAside===1?'The other waiting change was':`The ${review.setsAside} other waiting changes were`} set aside, not approved.`:'';
  S.notice=type==='accept_pip_update'?`${named} is updated.${aside}`+keepRunningTold(result):`Dismissed. ${named} stays as it was.`;
}
/** What the review page of a waiting change shows and sends: its words, its request, and whether it can be accepted. */
function proposalReviewSpec(proposal,reject=false) {
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
  const review={title:reject?'Turn this down?':`Change ${S.pip.name}?`,description:reject?`${S.pip.name} stays as it is.`:'Here’s what changes. Work already started isn’t affected.',body:personalPip()?personalProposalBody(proposal):pulseChange?pulseProposalBody(proposal,{stale,unavailable,pulseUnsupported,reject}):pathTrigger||S.pip.event_trigger?.commit_paths?pathProposalBody(proposal,{stale,unavailable,pathUnsupported,reject}):`<dl class="meta"><dt>Name</dt><dd>${esc(proposal.definition?.name)}</dd><dt>Branch or commit</dt><dd>${esc(proposal.definition?.source_ref)}</dd><dt>Model now</dt><dd>${esc(modelLabel(S.pip.model_choice))}</dd><dt>Model after</dt><dd>${esc(modelLabel(proposal.definition?.model_choice))}</dd><dt>Asked</dt><dd>${proposal.actor?esc(requester(proposal.actor)):'Not recorded'}</dd><dt>Expires</dt><dd>${proposal.expires_at?esc(date(proposal.expires_at)):'Not recorded'}</dd></dl><h3>What it would do</h3><p class="goal">${esc(proposal.definition?.goal)}</p><h3>Source</h3><dl class="meta"><dt>Now</dt><dd>${esc(sourcePolicyLabel(S.pip.source_policy))}</dd><dt>After</dt><dd>${esc(sourcePolicyLabel(proposal.definition?.source_policy))}</dd></dl><p class="muted">With your current files, it copies your saved files each time you ask (skipping files that may hold secrets); that isn’t a commit. It then runs only when you ask, with no handoffs. Changing this turns off its schedule and triggers, and switching back doesn’t bring them back.</p><h3>Changes it may make to itself</h3><dl class="meta"><dt>Now</dt><dd>${esc(adaptationLabel(S.pip.adaptation_policy))}</dd><dt>After</dt><dd>${esc(adaptationLabel(proposal.definition?.adaptation_policy))}</dd></dl><p class="muted">If it may move to a newer commit, later runs read that commit. It can never change its goal, model, schedule, triggers or permissions, or this setting. Accepting this alone runs nothing.</p>${pulseChange?`<h3>Commands now</h3>${pulsePlanReview(S.pip.verification_plan)}<h3>Commands after</h3>${pulsePlanReview(proposal.definition?.verification_plan)}`:''}<h3>Schedule</h3><dl class="meta"><dt>Now</dt><dd>${esc(currentSchedule)}</dd><dt>After</dt><dd>${esc(proposedSchedule)}</dd></dl><h3>Events</h3><dl class="meta"><dt>Now</dt><dd>${esc(eventTriggerLabel(S.pip.event_trigger))}</dd><dt>After</dt><dd>${esc(eventTriggerLabel(proposal.definition?.event_trigger))}</dd></dl>${commitRulesMarkup(S.pip.event_trigger?.commit_paths,'Paths it watches now')}${commitRulesMarkup(proposal.definition?.event_trigger?.commit_paths,'Paths it would watch')}${pathTrigger?`<p class="notice">Any other event you ticked can also start it, even without a path change. The minimum gap applies to all of them.</p><p class="muted">${esc(commitPathNotice)}</p>`:''}${quillAutomation?`<p class="notice">${esc(quillAutomationNotice)}</p>`:''}${sessionTrigger?`<p class="muted">${esc(sessionTurnNotice)}</p>`:''}<p class="muted">It runs on a schedule or on events, not both. Accepting doesn’t replay past events; if several happen while Pips are off, an active Pip runs once, and a paused or busy one skips them. ${documentationPip(S.pip)?'Events start private drafts.':'Events start read-only audits.'} They never start handoffs, fixes or tests.</p><p class="muted">A schedule runs while this Pip is active and Pips are running. If Pips were off, it runs once for the times it missed. A paused or busy Pip skips a scheduled time and picks up at the next one. When clocks change, a missing time is skipped and a repeated one runs once. What it may use doesn’t change.</p><p class="muted">${esc(proposal.reason)}</p><details><summary>Full setup (JSON)</summary><pre>${esc(JSON.stringify(proposal.definition,null,2))}</pre></details>${!reject&&stale?'<p class="notice error">This was written for an older version of this Pip. Turn it down and ask again.</p>':''}${pulseUnsupported?'<p class="notice error">This command plan can’t be accepted here. Update DGC, then refresh.</p>':''}${quillUnsupported?'<p class="notice error">Update DGC to accept a Quill schedule or events.</p>':''}${pathUnsupported?'<p class="notice error">These paths can’t be accepted here. Update DGC, then refresh.</p>':''}${sessionUnsupported?'<p class="notice error">Update DGC to accept a chat-turn trigger.</p>':''}${sourceUnsupported?'<p class="notice error">Update DGC to accept this source change.</p>':''}${unavailable?'<p class="notice error">This was already answered or is no longer available. Refresh to see it.</p>':''}${proposal.expires_at&&Date.parse(proposal.expires_at)<=Date.now()?'<p class="notice error">This expired. Ask again for a new one.</p>':''}`,confirm:reject?'Turn down':'Accept',requiresCommitPaths:!reject&&pathTrigger,requiresPulsePlan:!reject&&pulseChange,requiresQuillAutomation:!reject&&quillAutomation,requiresSessionTurn:!reject&&sessionTrigger,blocked:unavailable||(!reject&&stale),expiresAt:proposal.expires_at,request:{type:reject?'reject_pip_update':'accept_pip_update',pip_id:S.selected,proposal_id:proposal.id,expected_version:proposal.expected_version}};
  // GitHub reads are shown whichever body variant reviewed the rest; a plan this view cannot read blocks acceptance.
  // A Personal Pip's computer is shown whenever the proposal keeps, gives or removes one.
  if(personalPip()&&(S.pip?.computer_plan||proposal.definition?.computer_plan)){const label=v=>v?'Its own browser, Terminal and files. Anything it would submit waits for your OK.':'None';review.body+=`<dl class="meta"><dt>Computer now</dt><dd>${label(S.pip.computer_plan)}</dd><dt>Computer after</dt><dd>${label(proposal.definition?.computer_plan)}</dd></dl>`;}
  if(others.length){review.setsAside=others.length;review.body+=`<p class="notice">${others.length===1?'Another change for this Pip is waiting too. It was written for the same version, so accepting this one sets that one aside. It is not approved. Ask the Pip again if you still want it.':`${others.length} other changes for this Pip are waiting too. They were written for the same version, so accepting this one sets them aside. They are not approved. Ask the Pip again if you still want them.`}</p>`;}
  if(!personalPip()&&(S.pip?.github_plan||proposal.definition?.github_plan)){let section;try{if(proposal.definition?.github_plan)githubReadPlan(proposal.definition.github_plan);section=githubProposalMarkup(proposal);}catch{section='<p class="notice">These GitHub reads are not supported by this view. Update DGC before accepting.</p>';if(!reject)review.blocked=true;}review.body+=section;}
  return review;
}
function updateDraft(event) {
  if(event.target.id==='pip-search'){draft.pipSearch=event.target.value;searchPips(event.target.value);return;}
  if(event.target.dataset?.cardEdit!==undefined){const e=cardEdits.get(event.target.dataset.cardEdit);if(e&&event.target.dataset.cardField in e.values)e.values[event.target.dataset.cardField]=event.target.value;return;}
  if(event.target.dataset?.commitRule!==undefined){const row=commitRules[Number(event.target.dataset.commitRule)];if(row){if(event.target.dataset.commitKind!==undefined)row.kind=event.target.value;else row.path=event.target.value;S.scheduleDirty=true;}return;}
  if(event.target.dataset?.pulseCommand!==undefined){const i=Number(event.target.dataset.pulseCommand),row=pulseCommands[i];if(row){if(event.target.dataset.pulseArg!==undefined)row.argv[Number(event.target.dataset.pulseArg)]=event.target.value;else row.cwd=event.target.value;S.scheduleDirty=true;}return;}
  const key=event.target.dataset?.draft;if(!(key in draft))return;draft[key]=event.target.type==='checkbox'?event.target.checked:event.target.value;
  if(key==='noteAdd'){const add=document.querySelector('#note-add-form button[type=submit]');if(add)add.disabled=notesBusy||!usable()||!draft.noteAdd.trim();}
  if(key==='outcomeSession'){outcomeInspectSeq++;outcomeInspection=null;outcomeInspecting=false;outcomeSessionsError='';}
  if(key==='chatText'&&S.selected){chatDrafts.set(S.selected,draft.chatText);rememberMarks();rememberView();fitChatInput();
    // The box emptied or got its first word: voice mode and Send trade places (the caret is kept across the redraw;
    // the rich box stays where it is, and a selection set in an open composition would cancel it).
    if(voiceMode&&!!$('chat-voicemode')===!!draft.chatText.trim()){const at=event.target.selectionStart;render();const box=$('chatText');if(box&&box!==chatBox?.el){box.focus();box.setSelectionRange(at,at);}}}
  if(key==='sourceMode'||key==='sourceReason'||key==='sourceExcludeInput')S.sourceDirty=true;
  if(key==='pipModel')S.modelDirty=true;
  if((key==='pipPageName'||key==='pipPageTitle')&&!pageNameDirty){pageNameDirty=true;render();}
  if(key==='routineKind'&&event.type==='change'){if(draft.routineKind==='app'){if(!draft.routineApp)draft.routineApp=ownAppNames()[0]||'';void loadAppEvents(draft.routineApp);}render();}
  if(key==='routineApp'&&event.type==='change'){render();void loadAppEvents(draft.routineApp);}
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
document.addEventListener('input',event=>{if(event.target?.id==='importLink'||event.target?.id==='importReply')importTyped();});
document.addEventListener('input',event=>{
 const id=event.target.id;if(id==='flow-name')flowDraft.name=event.target.value;
 else if(/^flow-task-[0-2]$/.test(id))flowDraft.tasks[Number(id.slice(-1))]=event.target.value;
});
document.addEventListener('change',event=>{
 const id=event.target.id;
 if(id==='flow-mode')flowDraft.mode=event.target.value;
 else if(id==='flow-count'){flowDraft.count=Number(event.target.value);render();}
 else if(/^flow-pip-[0-3]$/.test(id))flowDraft.pips[Number(id.slice(-1))]=event.target.value;
});
document.addEventListener('paste',event=>{if(event.target?.id!=='chatText'||!canAttachImages())return;const files=[...(event.clipboardData?.files||[])];if(!files.length)return;event.preventDefault();addImageFiles(files);});
document.addEventListener('dragover',event=>{if(canAttachImages()&&event.target?.closest?.('#chat-form')&&[...(event.dataTransfer?.types||[])].includes('Files'))event.preventDefault();});
// "Drop to attach" over the box while files are over it (the shared overlay's look, media/shared/composer.css).
let dropDepth=0;
const dropOverlay=on=>{const o=document.querySelector('#chat-form > .dgc-drop');if(o)o.hidden=!on;};
document.addEventListener('dragenter',event=>{if(!canAttachImages()||!event.target?.closest?.('#chat-form')||![...(event.dataTransfer?.types||[])].includes('Files'))return;dropDepth++;dropOverlay(true);});
document.addEventListener('dragleave',event=>{if(!event.target?.closest?.('#chat-form'))return;dropDepth=Math.max(0,dropDepth-1);if(!dropDepth)dropOverlay(false);});
document.addEventListener('drop',event=>{dropDepth=0;dropOverlay(false);if(!canAttachImages()||!event.target?.closest?.('#chat-form'))return;const files=[...(event.dataTransfer?.files||[])];if(!files.length)return;event.preventDefault();addImageFiles(files);});
document.addEventListener('change',event=>{if(event.target.dataset?.pluginLevel){const t=event.target,level=t.value,label=(PLUGIN_LEVELS.find(l=>l[0]===level)||[])[1]||level;void pipsSettingsCall('set_plugin_permission',{plugin:t.dataset.pluginLevel,level},`Saved. ${t.dataset.pluginName||'This plugin'}: ${label.toLowerCase()}.`);return;}if(event.target.id==='chat-attach-input'){addImageFiles(event.target.files||[]);event.target.value='';return;}if(event.target.id==='keep-running'){void setKeepRunning(event.target.checked);return;}if(event.target.id==='hook-network'){const on=event.target.checked;void reachCall({local_network:on},'network',on?'Devices on your home network can call your routines’ addresses.':'Your home network can no longer call your routines’ addresses.');return;}if(event.target.id==='desktop-notifications'){void setDesktopNotifications(event.target.checked);return;}if(event.target.id==='pipKnowsYou'){void setKnowsYou(event.target.checked);return;}if(event.target.id==='pipEyes'){void setEyes(event.target.value);return;}if(event.target.id==='pipLevel'){const picked=event.target.value;if(picked==='full'&&onePips()&&levelState.value?.level!=='full')event.target.value=levelState.value?.level||'ask';chooseLevel(picked,{refocus:'pipLevel'});return;}if(event.target.id==='pipPaying'){void setPaying(event.target.value);return;}if(event.target.id==='pipReportAs'){const v=event.target.value;void setArtifacts({report_as:v},value=>reportNotice(value,S.pip?.name||'It'));return;}if(event.target.id==='pipDashboardAdd'){const id=event.target.value;if(id&&artifactsState.value){const list=[...artifactsState.value.dashboards,id];void setArtifacts({dashboards:dashboardsToSave(list)},`${S.pip?.name||'It'} refreshes “${dashboardTitle(id)}” after every run it finishes.${goneNote(list)}`);}return;}if(event.target.dataset?.loginAll){const l=(loginsState.value||[]).find(x=>x.id===event.target.dataset.loginAll),all=event.target.checked;if(l)void loginCall('grant_pip_login',{login_id:l.id,pips:all?'all':[S.selected]},all?`All your Pips can use the login for ${l.site}.`:`Only ${S.pip?.name||'this Pip'} uses the login for ${l.site} now.`);return;}if(event.target.dataset?.pipAppSwitch){void setAppUse(event.target.dataset.pipAppSwitch,event.target.checked);return;}if(event.target.dataset?.pipSkillSwitch){void setSkillUse(event.target.dataset.pipSkillSwitch,event.target.checked);return;}if(event.target.dataset?.teamPip){teamTicked(event.target);return;}if(event.target.id==='pipCareful'){const on=event.target.checked;void carefulCall('set_pip_careful',{on},on?'Careful mode is on.':'Careful mode is off. Its submits still wait for you.');return;}if(event.target.id==='pipNotify'){const on=event.target.checked;void setProfile({notify:on},on?'It tells you when it finishes something on its own or needs you.':'It won’t notify you. Its chat still has everything.');return;}if(event.target.dataset?.routineToggle){const id=event.target.dataset.routineToggle,on=event.target.checked;void routineCall('update_pip_routine',{routine_id:id,changes:{status:on?'on':'off'}},id,on?'Routine on.':'Routine off. It won’t run until you turn it on.');return;}if(event.target.id==='chat-context'){updateChatPreference('context_size',event.target.value);return;}if(event.target.id==='chat-thinking'){const step=Number(event.target.value);if(step>=5){void setPipUltra(true);return;}if(pipUltra())void setPipUltra(false);updateChatPreference('thinking',chatThinkingLevels[step]);return;}if(event.target.id==='commandReceiptSession'){commandDetailSeq++;commandSeq++;commandLoading=false;commandSession=event.target.value;commandReceipts=[];commandLoaded=false;commandCursor=null;commandMore=false;void loadCommandReceipts();return;}updateDraft(event);});
document.addEventListener('submit',event=>{
  if(event.target.id==='pip-flow-form'){event.preventDefault();reviewFlow();return;}
  if(event.target.id==='pip-folder-form'){event.preventDefault();addPipFolder();return;}
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
    void mutate({...request,idempotency_key:saved.key},async result=>{const h=handoffRecord(result.handoff,S.selected,S.workspace.id);if(h.source_run_id!==saved.runId||(saved.artifact?(h.payload.type!=='patch_artifact.v1'||h.payload.source.artifact.sha256!==saved.artifact.artifact.sha256||h.payload.source.result_digest!==saved.artifact.result_digest||h.payload.source.review_revision!==saved.artifact.review_revision):h.payload.source.finding_index!==saved.index)||h.target_pip_id!==target.id)throw new Error('The saved handoff doesn’t match what you chose. Refresh and try again.');S.handoffDraft=null;
      // Taken by the target Pip's level (Pips API 80, pips-11): it runs now, in its own copy; nothing to review.
      if(h.status==='accepted'&&String(h.resolved_by||'').startsWith('pip-level:')){S.notice=`${h.payload.target.name}’s level took it: it runs now, in its own copy.`;if(handoffScope!==scope())return;render();void loadHandoffs();return;}
      S.notice='Handoff saved. Nothing starts until you approve it.';if(h.payload.action.kind!=='read_only')await loadExecution();if(handoffScope!==scope())return;reviewHandoff(h);void loadHandoffs();});return;
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
    let choice;try{choice=modelChoice(draft.pipModel,S.models,subscriptionChoices(personalPip()),routerOffer(),savedProviders());}catch(error){setError(error);return;}
    void applyOwnChange({model_choice:choice},d=>JSON.stringify(d.model_choice)===JSON.stringify(choice),`Model saved: ${modelLabel(choice)}. Its next run uses it.${choice.mode==='subscription'?' '+usageLine(modelValue(choice)):''}`).then(ok=>{if(ok)S.modelDirty=false;});return;
  }
  if(id==='create-form'){
    if(S.workspace?.kind==='personal'){S.createType=$('personal-character').value;S.createStep='configure';draft.source_ref='HEAD';}
    const selectedType=S.types.find(t=>t.id===S.createType);
    if(!S.create||S.createStep!=='configure'||!selectedType?.available){setError('Choose an available Pip type first.');return;}
    if(!draft.name.trim()||!draft.goal.trim()||!draft.source_ref.trim()){setError('Give it a name, say what it does, and choose a branch or commit.');return;}
    let choice;try{choice=modelChoice(draft.createModel,S.models,subscriptionChoices(S.workspace?.kind==='personal'),routerOffer(),savedProviders());}catch(error){setError(error);return;}
    const request={type:'create_pip',workspace_id:S.workspace.id,pip_type:selectedType.id,model_choice:choice,name:draft.name.trim(),goal:draft.goal.trim(),source_ref:draft.source_ref.trim()};
    if(executionPip(selectedType)&&S.workspace?.kind!=='personal')openReview(executionCreateReview(selectedType,request,choice));
    else void mutate(request,finishCreate);
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
  const pinned=event.target.closest?.('[data-pin-pip]');
  if(pinned){
   const p=(S.jobs||[]).find(job=>job.id===pinned.dataset.pinPip);
   if(p)vscode.postMessage({type:'dockToggle',item:{kind:'pip',id:p.id,title:p.name,scope:personalPip(p)?'':'project',look:{body:(personalPip(p)&&profile(p.profile).body)||p.pip_type,ws:p.workspace_id||''}}});
   return;
  }
  if(picker.click(event))return;
  if(DgcCard.click(event.target))return;   // a card's Details opens in place
  if(allowFromOpen&&!event.target.closest?.('.allow-from'))closeAllowFrom();
  if(folderUi.open&&!event.target.closest?.('.pip-folder-set'))closeFolderMenu();
  if(S.composerPanel&&!event.target.closest?.('.composer-model-menu,.pip-routines-popover,.composer-add-menu,.composer-level-menu,#chat-model,#chat-context-toggle,#chat-routines,#chat-attach,#chat-level')){S.composerPanel='';render();}
  if(event.target.closest?.('#pip-sent-toggle')){toggleSent();return;}
  {const tab=event.target.closest?.('.composer-model-menu [data-model-tab]');if(tab){const to=tab.dataset.modelTab==='agents'?'agents':'main';if(S.modelTab!==to){S.modelTab=to;if(to==='main')S.modelListOpen=true;render();}$(`chat-model-tab-${to}`)?.focus();return;}}
  if(event.target.closest?.('#chat-voicemode')){S.error='';voiceMode?.start();return;}
  const talkAction=event.target.closest?.('[data-voicebar="pips-talk"] [data-voice-action]')?.dataset.voiceAction;
  if(talkAction){voiceMode?.action(talkAction);return;}
  if(event.target.closest?.('#chat-mic')&&S.mic==='idle'){const box=$('chatText');micCaret=box?[box.selectionStart,box.selectionEnd]:null;S.error='';micShow('starting');render();vscode.postMessage({type:'micStart',from:'pips'});return;}
  const voiceAction=event.target.closest?.('[data-voice-action]')?.dataset.voiceAction;
  if(voiceAction==='cancel'){micCancel();return;}
  if((voiceAction==='stop'||voiceAction==='send')&&S.mic==='recording'){micShow('writing',voiceAction);render();vscode.postMessage({type:'micStop',mode:voiceAction==='send'?'send':'insert',from:'pips'});return;}
  const link=event.target.closest?.('.md-link');
  // "Preview: <title>" under a reply's HTML or SVG block: the page opens in a tab beside (src/codePreview.ts).
  if(link?.dataset.linkKind==='preview'){event.preventDefault();const view=window.DgcMarkdown?.previewOf?.(link);if(view)vscode.postMessage({type:'codePreview',...view});return;}
  if(link){event.preventDefault();const target=window.DgcMarkdown?.linkOf?.(link.dataset);if(target?.kind==='external')vscode.postMessage({type:'openExternal',url:target.target});else if(target?.kind==='file')vscode.postMessage({type:'openFile',path:target.target,line:target.line,endLine:target.endLine});return;}
  const copy=event.target.closest?.('button.copy[data-c]');if(copy){event.preventDefault();try{vscode.postMessage({type:'copy',text:decodeURIComponent(copy.dataset.c)});copy.classList.add('done');copy.title='Copied';copy.setAttribute('aria-label','Copied');copy.innerHTML=transcriptIcon('check');}catch{/* malformed generated data is not copied */}return;}
  // Download on a file's row in a reply (pips-08): the host asks where to save the kept file.
  const download=event.target.closest?.('button[data-message-download]');
  if(download&&S.apiVersion>=43&&!remoteHost){openMessageImage(download.dataset.messageDownload,true);return;}
  const photo=event.target.closest?.('img[data-message-image]');
  if(photo&&S.apiVersion>=43&&!remoteHost){openMessageImage(photo.dataset.messageImage);return;}
  const target=event.target.closest('button');if(!target||target.disabled)return;
  if(flow.menu&&!target.dataset.flowMenu&&!target.dataset.flowHelper){flow.menu='';render();}
  if(target.dataset.pipsTab){chooseScopeTab(target.dataset.pipsTab);return;}
  // The Project Folder dropdown (the Project tab's, and Create a Project Pip's), and a Pip in the list of every project's.
  if(target.dataset.folderPick){openFolderMenu(target,event.detail===0);return;}
  if(target.dataset.projectPip){void navigateFromHost({pip:target.dataset.projectPip}).catch(error=>setError(error));return;}
  if(target.dataset.workingNotes){if(target.dataset.workingNotes==='edit'&&S.workingNotes){workingNotesEditing=true;draft.workingNotesText=S.workingNotes.lines.join('\n');render();$('workingNotesText')?.focus();}else if(target.dataset.workingNotes==='cancel'){workingNotesEditing=false;draft.workingNotesText='';S.workingNotesError='';render();void loadWorkingNotes();}return;}
  if(target.dataset.pipLearn){const l=S.learn,a=target.dataset.pipLearn;if(a==='save')void saveLearn();else if(a==='edit'&&l?.status==='draft'){if(l.editing)l.text=draft.pipLearnText;else draft.pipLearnText=l.text;l.editing=!l.editing;render();if(l.editing)$('pipLearnText')?.focus();}else if(a==='cancel'&&l){S.learn={pip:l.pip,status:'cancelled',name:l.name};render();}else if(a==='dismiss'){S.learn=null;render();$('chatText')?.focus();}return;}
  if(target.id==='chat-level'){S.composerPanel=S.composerPanel==='level'?'':'level';render();if(S.composerPanel==='level'){focusLevelMenu();void loadLevel().then(()=>{if(S.composerPanel==='level')focusLevelMenu();});}return;}
  if(target.dataset.pipLevelPick!==undefined){const chosen=target.dataset.pipLevelPick;S.composerPanel='';render();$('chat-level')?.focus();
   chooseLevel(chosen,{refocus:'chat-level'});return;}
  if(target.dataset.pipLevelWhat!==undefined){S.composerPanel='';render();openWhatItCanDo();return;}
  if(target.id==='chat-attach'){S.composerPanel=S.composerPanel==='add'?'':'add';render();if(S.composerPanel==='add')document.querySelector('.composer-add-menu .dgc-menu-row')?.focus();return;}
  if(target.dataset.pipAdd!==undefined){const which=target.dataset.pipAdd;S.composerPanel='';render();
   if(which==='upload'){$('chat-attach-input')?.click();return;}
   // Set a goal: the box starts with /goal, what is written after it is the goal, and nothing is set until it is sent.
   if(which==='goal'){const box=$('chatText');if(box&&goalsOn()){box.focus();if(!goalRequest(box.value)){chatEdit(()=>box.setRangeText('/goal ',0,0,'end'));box.dispatchEvent(new Event('input',{bubbles:true}));}const end=box.value.length;box.setSelectionRange?.(end,end);}return;}
   const box=$('chatText');if(box){box.focus();const at=box.selectionStart??box.value.length,before=box.value.slice(0,at);chatEdit(()=>box.setRangeText((before&&!/\s$/.test(before)?' ':'')+'@',at,box.selectionEnd??at,'end'));box.dispatchEvent(new Event('input',{bubbles:true}));}
   return;}
  if(target.dataset.openImage!==undefined){const image=pendingImages()[Number(target.dataset.openImage)];if(image?.data)globalThis.DgcComposer?.preview(target.closest('.dgc-att'),{src:image.data,name:image.name||'',box:$('chat-form')});return;}
  if(target.dataset.replyRemove!==undefined){chatReplies.delete(S.selected);render();$('chatText')?.focus();return;}
  if(target.dataset.removeFile!==undefined){const i=Number(target.dataset.removeFile),files=[...pendingFiles()];if(Number.isInteger(i)&&i>=0&&i<files.length){files.splice(i,1);files.length?chatFiles.set(S.selected,files):chatFiles.delete(S.selected);render();$('chatText')?.focus();}return;}
  if(target.dataset.removeImage!==undefined){const i=Number(target.dataset.removeImage),images=[...pendingImages()];if(Number.isInteger(i)&&i>=0&&i<images.length){images.splice(i,1);images.length?chatImages.set(S.selected,images):chatImages.delete(S.selected);render();$('chatText')?.focus();}return;}
  if(target.id==='pin-pips-sidebar'){S.sidebarPinned=!S.sidebarPinned;rememberView();render();return;}
  if(target.dataset.chatActivity){void toggleChatActivity(target.dataset.chatActivity);return;}
  if(target.dataset.postTrace){void openReplyTrace(target.dataset.postTrace,'');return;}
  if(target.dataset.chatAction){
    const m=S.messages.find(m=>m.id===target.dataset.messageId);if(!m)return;
    if(target.dataset.chatAction==='read'){reader?.toggle(m.id,m.text);return;}
    if(target.dataset.chatAction==='trace'){void openReplyTrace(m.run_id,m.model);return;}
    if(target.dataset.chatAction==='copy'){vscode.postMessage({type:'copy',text:m.text});target.innerHTML=transcriptIcon('check')+'<span class="sr-only">Copied</span>';target.title='Copied';target.setAttribute('aria-label','Copied');const status=target.parentElement.querySelector('.copy-feedback');if(status)status.textContent='Copied';return;}
    if(target.dataset.chatAction==='reply'){if(m.role!=='assistant'||!canReply())return;chatReplies.set(S.selected,{id:m.id,text:String(m.text).slice(0,600)});render();$('chatText')?.focus();return;}
    if(target.dataset.chatAction==='resend'){if(pendingImages().length||pendingFiles().length){setError('Send or remove what’s attached first, then send this again.');return;}chatQueueSendText(m.text,m.display_mentions);return;}
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
  if(target.dataset.computerAlways){void alwaysInChat(target.dataset.computerAlways);return;}
  if(target.dataset.cardOpen){cardRefused='';if(computerState.pip===S.selected&&computerState.value?.granted)void openComputerView();render();return;}
  if(target.dataset.cardDismiss){cardRefused='';render();return;}
  if(target.dataset.revokeGrant){revokeGrant(target.dataset.revokeGrant);return;}
  if(target.dataset.routineAdd){const id=target.dataset.routineAdd;void routineCall('decide_pip_routine',{routine_id:id,add:true},id,routineStartNotice);return;}
  if(target.dataset.routineDecline){const id=target.dataset.routineDecline;void routineCall('decide_pip_routine',{routine_id:id,add:false},id,'');return;}
  if(target.dataset.hookCopy){copyHookAddress(target.dataset.hookCopy);return;}
  if(target.dataset.hookShow!==undefined){hook.shown=!hook.shown;render();return;}
  if(target.dataset.hookReplace!==undefined){replaceHookAddress();return;}
  if(target.dataset.hookSigningRemove!==undefined){saveHookSigning(true);return;}
  if(target.dataset.hookTest!==undefined){if(!S.busy)void hookCall('send_pip_webhook_test',{},'test',value=>{hook.tested=webhookTestLine(value);});return;}
  if(target.dataset.hookReach!==undefined){openReachSettings();return;}
  if(target.dataset.hookClose!==undefined){closeHook();render();return;}
  if(target.dataset.reachTailscale!==undefined){askTailscale();return;}
  if(target.dataset.reachOff!==undefined){if(!S.busy)void reachCall({tunnel:null},'off','Turned off. Services on the internet can no longer reach your routines.');return;}
  if(target.id==='pip-goal-stop'){void stopGoal();return;}
  if(target.id==='pip-goal-dismiss'){dismissGoal();return;}
  if(target.id==='pip-goal-details'){goalState.details=!goalState.details;render();$('pip-goal-details')?.focus();return;}
  if(target.id==='pip-goal-more'){goalState.open=!goalState.open;render();$('pip-goal-more')?.focus();return;}
  if(target.id==='pip-owner-change'){void openOwnerPicker();return;}
  if(target.id==='pip-owner-cancel'){ownerState.picker=null;render();$('pip-owner-change')?.focus();return;}
  if(target.dataset.ownerSession!==undefined){void chooseOwner(target.dataset.ownerSession||null);return;}
  if(target.dataset.routineEdit){editRoutine(target.dataset.routineEdit);return;}
  if(target.dataset.routineNew!==undefined){editRoutine('new');return;}
  if(target.dataset.routineCancel!==undefined){routineEditing='';routineError='';closeHook();render();return;}
  if(target.dataset.routineDelete){const id=target.dataset.routineDelete;void routineCall('delete_pip_routine',{routine_id:id},id,'Routine deleted.').then(r=>{if(r){routineEditing='';closeHook();render();}});return;}
  if(target.dataset.routineLegacy!==undefined){S.legacyOpen=!S.legacyOpen;render();return;}
  if(target.dataset.pipPage){const v=target.dataset.pipPage;if(v==='instructions')draft.pipInstructions=S.pip?.goal||'';if(v==='character'){const look=profile(S.pip?.profile);draft.lookBody=look.body||'';lookDirty=false;}S.pipPage=v;render();if(v==='instructions')$('pipInstructions')?.focus();if(v==='info')void loadRoutines();return;}
  if(target.dataset.pipPageTab){S.pipPage=target.dataset.pipPageTab;routineEditing='';render();if(S.pipPage==='info')void loadRoutines();else void loadShared(S.pipPage);return;}
  if(target.dataset.pipShare!==undefined){document.querySelectorAll('details[data-details="pip-menu"]').forEach(d=>d.removeAttribute('open'));void exportPipFile();return;}
  if(target.dataset.pipCharacterReset!==undefined){draft.lookBody='';lookDirty=true;render();return;}
  if(target.dataset.pipCharacterSave!==undefined){const own=S.pip?.pip_type,body=draft.lookBody&&draft.lookBody!==own?draft.lookBody:null;void setProfile({body},'Saved. That’s its face now.').then(ok=>{if(ok){lookDirty=false;S.pipPage='info';render();}});return;}
  if(target.dataset.pipNameCancel!==undefined){draft.pipPageName=S.pip?.name||'';draft.pipPageTitle=profile(S.pip?.profile).title;pageNameDirty=false;titleEditing=false;render();return;}
  if(target.dataset.pipTitleEdit!==undefined){titleEditing=true;render();const box=$('pipPageTitle');box?.focus();box?.select?.();return;}
  if(target.dataset.openLink){vscode.postMessage({type:'openExternal',url:target.dataset.openLink});return;}
  if(target.dataset.openComputerFiles!==undefined){if(computerState.pip===S.selected&&computerState.value?.granted)void openComputerView();return;}
  if(target.dataset.setupChat!==undefined){S.tab='chat';chatEdit(()=>{draft.chatText='Change your instructions: ';chatDrafts.set(S.selected,draft.chatText);rememberView();render();});void loadMessages();$('chatText')?.focus();return;}
  if(target.dataset.copyPipId!==undefined){document.querySelectorAll('details[data-details="pip-menu"]').forEach(d=>d.removeAttribute('open'));vscode.postMessage({type:'copy',text:S.selected});S.notice='Copied its ID.';render();return;}
  if(target.dataset.pipsSettings){pipsSettings.view=target.dataset.pipsSettings;render();void loadPipsSettings();if(pipsSettings.view==='apps'&&payTotalState.asked)void loadPayTotal();return;}
  if(target.dataset.computersUpdate!==undefined){void pipsSettingsCall('update_pip_computers',{},r=>r?.started?'Checking for updates. This can take a few minutes.':'Already checking for updates.');return;}
  if(target.dataset.computerResetAsk){pipsSettings.confirmReset=target.dataset.computerResetAsk;render();return;}
  if(target.dataset.computerResetCancel!==undefined){pipsSettings.confirmReset='';render();return;}
  if(target.dataset.computerReset){void pipsSettingsCall('reset_pip_computer',{pip_id:target.dataset.computerReset},r=>r?.reset?'Its computer is fresh: signed out, no history. Its Files are still there.':'Resetting its computer: it is fresh the next time it opens. Its Files stay.');return;}
  if(target.dataset.appRemove){void pipsSettingsCall('disconnect_pip_app_link',{pip_id:target.dataset.appRemovePip,link_id:target.dataset.appRemove},'Removed. That Pip no longer uses the account.');return;}
  // A card's icons: its answer (held a moment, with Undo), or Review, which opens it as the card itself does.
  if(target.dataset.attentionAnswer){answerSoon(target.dataset.attentionItem,target.dataset.attentionAnswer==='yes');return;}
  if(target.dataset.attentionUndo){undoAnswer(target.dataset.attentionUndo);return;}
  if(target.dataset.attention||target.dataset.attentionOpen){const id=target.dataset.attention||target.dataset.attentionOpen,found=S.attention?.items.find(i=>i.id===id),item=found&&codeRow(found,attentionVisits);if(item)void navigateFromHost(attentionNavigation(item)).catch(setError);return;}
  if(target.dataset.attentionDismiss){
   const item=S.attention?.items.find(i=>i.id===target.dataset.attentionDismiss);
   if(item?.kind==='setup')rejectSoon(item.card,()=>dismissSetupFromAttention(item,{quiet:true}));
   return;
  }
  if(target.dataset.eyesSwitch){const model=target.dataset.eyesSwitch,held=S.pip?.model_choice,choice=held?.mode==='provider'?{mode:'provider',provider:held.provider,model}:{mode:'model',model};void applyOwnChange({model_choice:choice},d=>JSON.stringify(d.model_choice)===JSON.stringify(choice),`${S.pip.name} now uses ${model}, which can see.`).then(ok=>{if(ok)void loadEyes();});return;}
  if(target.dataset.levelAsk!==undefined){void setLevel('ask');return;}
  if(target.dataset.dashboardRemove){const id=target.dataset.dashboardRemove;if(artifactsState.value){const list=artifactsState.value.dashboards.filter(d=>d!==id),known=!artifactsState.dashboards||artifactsState.dashboards.some(d=>d.id===id);void setArtifacts({dashboards:dashboardsToSave(list)},known?`${S.pip?.name||'It'} no longer refreshes “${dashboardTitle(id)}”.${goneNote(list)}`:`Removed. ${S.pip?.name||'It'} refreshes ${list.length?'the others':'no dashboards'} now.`);}return;}
  if(target.dataset.artifactOpen){vscode.postMessage({type:'pipsOpenArtifact',id:target.dataset.artifactOpen,artifactType:target.dataset.artifactType||''});return;}
  if(target.dataset.templateAccept){void decideTemplateChange(target.dataset.templateAccept,target.dataset.templateDigest,'accept');return;}
  if(target.dataset.templateDecline){void decideTemplateChange(target.dataset.templateDecline,target.dataset.templateDigest,'reject');return;}
  if(target.dataset.siteForget){void carefulCall('forget_pip_site',{site:target.dataset.siteForget},`Removed. It asks before it opens ${target.dataset.siteForget} again.`);return;}
  if(target.dataset.sitesAll){sitesAll=true;render();return;}
  if(target.dataset.noteForget){const n=(S.notes||[]).find(x=>x.id===target.dataset.noteForget);void noteCall('forget_pip_note',{note_id:target.dataset.noteForget},()=>n?`Forgotten: ${n.text}`:'Forgotten.');return;}
  if(target.dataset.noteForgetAll){if(target.dataset.noteForgetAll==='ask'){noteConfirmAll=true;render();}else if(target.dataset.noteForgetAll==='no'){noteConfirmAll=false;render();}else void noteCall('forget_pip_note',{all:true},()=>{noteConfirmAll=false;return 'Forgotten. It remembers nothing about you now.';});return;}
  if(target.dataset.attentionAll){openAttentionAll();return;}
  if(target.dataset.attentionAllBack){closeAttentionAll();return;}
  if(target.dataset.attentionGo){attentionGo(target.dataset.attentionGo,Number(target.dataset.attentionIndex),{focus:true});return;}
  if(target.dataset.attentionMore!==undefined){attentionExpanded=Number(target.dataset.attentionMore)||false;
   // Folded by you: kept folded until something new is in it. Opened: it follows the rule again.
   if(attentionExpanded){attentionUserFolded=false;attentionFolded.clear();}else{attentionUserFolded=true;attentionFolded.clear();attentionKeys().forEach(k=>attentionFolded.add(k));}
   rememberView();render();return;}
  if(target.dataset.undoReject){const id=target.dataset.undoReject;undoReject(id);if(attentionAll.open)$('setup-review-'+id)?.focus?.({preventScroll:true});return;}
  if(target.dataset.pluginUseRemove){void pipsSettingsCall('decline_pip_plugin',{pip_id:target.dataset.pluginUsePip,grant_id:target.dataset.pluginUseRemove},'Removed. That Pip no longer uses the plugin.');return;}
  if(target.dataset.openPlugins!==undefined){vscode.postMessage({type:'openSettings',section:'plugins'});return;}
  if(target.dataset.openModels!==undefined){vscode.postMessage({type:'openSettings',section:'models'});return;}
  if(target.dataset.pipsRetry!==undefined){S.error='';render();refresh(true);return;}
  // Fix on a Pip whose routines can't run because its Claude Code or Codex is signed out: a terminal to sign it in.
  if(target.dataset.healthSignIn!==undefined){if(['claude','codex'].includes(target.dataset.healthSignIn)&&!remoteHost)vscode.postMessage({type:'pipsSignIn',engine:target.dataset.healthSignIn});return;}
  if(target.dataset.helloAgain!==undefined){void helloAgain();return;}
  if(target.dataset.pipRead){markPipRead(target.dataset.pipRead);return;}
  if(target.dataset.pipSwitch){void switchPip(target.dataset.pipSwitch);return;}
  if(target.dataset.job){if(onePips()&&(!S.selected||S.overview)&&!S.create){openOnePip(target.dataset.job);return;}if(event.detail>0&&!S.sidebarPinned)shell.classList.add('sidebar-dismissed');void select(target.dataset.job);return;}
  if(target.dataset.postOpen){openPostReport(target.dataset.postOpen);return;}
  if(target.dataset.postFix){askDgcAbout(target.dataset.postFix);return;}
  if(target.dataset.postFixOpen){openFixChat(target.dataset.postFixOpen);return;}
  if(target.dataset.postRun){if(canRunNow())runNow();return;}
  if(target.dataset.liveStop){void stopLive(target.dataset.liveStop);return;}
  if(target.dataset.postMore){const key=target.dataset.postMore;if(!shownInFull.delete(key))shownInFull.add(key);render();return;}
  if(target.dataset.lastPost){jumpToPost(target.dataset.lastPost);return;}
  if(target.dataset.chatRun){S.tab='runs';S.overview=false;render();void loadRun(target.dataset.chatRun);return;}
  if(target.dataset.lastRun){S.tab='runs';S.overview=false;render();void loadRun(target.dataset.lastRun).then(()=>document.querySelector('section[aria-label="Run report"]')?.scrollIntoView?.({block:'start'}));return;}
  if(target.dataset.run){void loadRun(target.dataset.run);return;}
  if(target.dataset.readNotification){void markNotification(target.dataset.readNotification);return;}
  if(target.dataset.openNotification){void openNotification(target.dataset.openNotification);return;}
  if(target.dataset.tab){document.querySelectorAll('details[data-details="tabs-more"],details[data-details="pip-menu"]').forEach(d=>d.removeAttribute('open'));S.tab=target.dataset.tab;S.create=false;S.overview=false;if(S.tab==='job'&&pagePip())openPipPage();else if(S.tab==='job')void loadArtifacts();rememberView();render();if(S.tab==='memory'){void loadMemories();if(S.apiVersion>=19)void loadStatements();}else if(S.tab==='notifications')void loadNotifications();else if(S.tab==='chat')void loadMessages();else if(S.tab==='runs')void loadSelected(true);else if(S.tab==='job')void loadModels();else if(S.tab==='context'&&S.apiVersion>=12){if(!outcomeSessionsLoaded)void loadOutcomeSessions();if(!outcomeLoaded)void loadOutcomes();}else if(S.tab==='handoffs'&&!S.handoffsLoaded)void loadHandoffs();return;}
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
  if(target.dataset.chatProvider){S.modelProviderChoice=target.dataset.chatProvider;S.modelProviderView=false;render();$('chat-model-providers')?.focus();return;}
  // D14: a model row's ⋯ opens Use as main and Use as fallback under it; choosing one of them closes them again.
  if(target.dataset.chatModelMore!==undefined){const v=target.dataset.chatModelMore;S.fallbackMenu=S.fallbackMenu===v?'':v;render();
   const dots=[...document.querySelectorAll('[data-chat-model-more]')].find(node=>node.dataset.chatModelMore===v);
   (S.fallbackMenu?dots?.closest('.dgc-menu-item')?.nextElementSibling?.querySelector('button:not(:disabled)'):dots)?.focus();return;}
  if(target.dataset.chatFallback!==undefined){void setPipBackup(fallbackChoice(target.dataset.chatFallback));return;}
  if(target.dataset.chatModel){S.fallbackMenu='';reviewChatModel(target.dataset.chatModel);return;}
  if(target.dataset.chatModelCustom){S.modelCustom=target.dataset.chatModelCustom;render();$('chat-model-custom')?.focus();return;}
  if(target.dataset.setup){void openSetup(target.dataset.setup);return;}
  if(target.dataset.rejectSetup){const id=target.dataset.rejectSetup;rejectSoon(id,()=>rejectSetupNow(id));return;}
  if(target.dataset.handoff){void openSavedHandoff(target.dataset.handoff);return;}
  if(target.dataset.rejectHandoff){void openSavedHandoff(target.dataset.rejectHandoff,true);return;}
  if(target.dataset.lineagePip){void openLineage(target.dataset.lineagePip,target.dataset.lineageRun);return;}
  if(target.dataset.changeAllow){void allowChange(target.dataset.changeAllow);return;}
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
  if(target.dataset.ownUndo!==undefined){void undoOwnChange(target.dataset.ownUndo);return;}
  if(target.dataset.ownDetails!==undefined){const id=target.dataset.ownDetails;if(ownDetailsOpen.has(id))ownDetailsOpen.delete(id);else ownDetailsOpen.add(id);render();return;}
  if(target.dataset.pipChoice!==undefined){
    // A tap answers with that choice; with words or files already in the box it joins them instead.
    const choice=target.dataset.pipChoice;
    if(draft.chatText.trim()||pendingImages().length||pendingFiles().length){chatEdit(()=>{draft.chatText=(draft.chatText.trim()?draft.chatText.trim()+' ':'')+choice;render();});$('chatText')?.focus();}
    else chatEdit(()=>{draft.chatText=choice;void sendChat();});
    return;
  }
  if(target.dataset.needsOpen){if(computerState.pip===S.selected&&computerState.value?.granted)void openComputerView();return;}
  if(target.dataset.needsDone){void finishedCheck();return;}
  if(target.dataset.allowFrom){const id=target.dataset.allowFrom;if(allowFromOpen===id){closeAllowFrom(true);return;}allowFromOpen=id;render();const menu=document.querySelector(`[data-allow-from-menu="${id}"]`);(menu?.querySelector('[aria-checked="true"]')||menu?.querySelector('.dgc-menu-row'))?.focus();return;}
  if(target.dataset.allowFromPick){const id=target.dataset.allowFromFor;allowFrom.set(id,target.dataset.allowFromPick);allowFromOpen='';render();document.querySelector(`[data-allow-from="${id}"]`)?.focus();return;}
  if(target.dataset.pipAppAskDisconnect){appsUse.confirm=target.dataset.pipAppAskDisconnect;render();document.querySelector('[data-pip-app-keep]')?.focus();return;}
  if(target.dataset.pipAppKeep!==undefined){const id=appsUse.confirm;appsUse.confirm='';render();document.querySelector(`[data-pip-app-ask-disconnect="${id}"]`)?.focus();return;}
  if(target.dataset.pipAppDisconnect){appsUse.confirm='';void appLinkAction('disconnect_pip_app_link',target.dataset.pipAppDisconnect);return;}
  if(target.dataset.pipAppAdd){void addAppAddress(target.dataset.pipAppAdd);return;}
  if(target.dataset.pipFolderOpen!==undefined){if(folderUi.open){closeFolderMenu(true);return;}folderUi.open=true;folderUi.error='';render();const menu=document.querySelector('.pip-folder-menu');(menu?.querySelector('[aria-checked="true"]')||menu?.querySelector('.dgc-menu-row'))?.focus();return;}
  if(target.dataset.pipFolderPick!==undefined){void setPipFolder(target.dataset.pipFolderPick);return;}
  if(target.dataset.pipFolderNew!==undefined){folderUi.open=false;folderUi.adding=true;folderUi.error='';draft.pipFolderName='';render();$('pipFolderName')?.focus();return;}
  if(target.dataset.pipFolderCancel!==undefined){folderUi.adding=false;folderUi.error='';draft.pipFolderName='';render();$('pip-folder-btn')?.focus({preventScroll:true});return;}
  if(target.dataset.pipFolderToggle!==undefined){const f=target.dataset.pipFolderToggle;if(foldersClosed.has(f))foldersClosed.delete(f);else foldersClosed.add(f);rememberView();render();[...document.querySelectorAll('[data-pip-folder-toggle]')].find(b=>b.dataset.pipFolderToggle===f)?.focus({preventScroll:true});return;}
  if(target.dataset.allowSend){void allowSend(target.dataset.allowSend);return;}
  if(target.dataset.allowAlways){void allowSend(target.dataset.allowAlways,true);return;}
  if(target.dataset.allowDismiss){void allowDismiss(target.dataset.allowDismiss);return;}
  if(target.dataset.allowCreate){void allowCreate(target.dataset.allowCreate);return;}
  if(target.dataset.allowCreateAlways){void allowCreate(target.dataset.allowCreateAlways,true);return;}
  if(target.dataset.cardEditStart){startCardEdit(target.dataset.cardEditStart);return;}
  if(target.dataset.cardEditUndo){cardEdits.delete(target.dataset.cardEditUndo);render();return;}
  if(target.dataset.appLinkAccount){void appLinkAction('start_pip_app_link',target.dataset.appLinkFor,false,{account:target.dataset.appLinkAccount});return;}
  if(target.dataset.appLinkAnother){void appLinkAction('start_pip_app_link',target.dataset.appLinkAnother,false,{another:true});return;}
  if(target.dataset.appLinkStart){void appLinkAction('start_pip_app_link',target.dataset.appLinkStart);return;}
  if(target.dataset.appLinkCheck){void appLinkAction('check_pip_app_link',target.dataset.appLinkCheck);return;}
  if(target.dataset.appLinkDecline){void appLinkAction('decline_pip_app_link',target.dataset.appLinkDecline);return;}
  if(target.dataset.appLinkDisconnect){void appLinkAction('disconnect_pip_app_link',target.dataset.appLinkDisconnect);return;}
  // No connector for it, or Composio isn't set up: the plugin directory, searching for that app.
  if(target.dataset.appLinkSettings){vscode.postMessage({type:'openSettings',section:'plugins',browse:String(target.dataset.appLinkApp||'')});return;}
  if(target.dataset.composerMore!==undefined){S.composerNoteOpen=!S.composerNoteOpen;render();document.querySelector('[data-composer-more]')?.focus();return;}
  if(target.dataset.projectFile!==undefined&&target.dataset.projectOf){toggleProjectFile(target.dataset.projectOf,target.dataset.projectFile);return;}
  if(target.dataset.projectApply){void projectDecide('apply',target.dataset.projectApply);return;}
  if(target.dataset.projectReview){projectReview(target.dataset.projectReview);return;}
  if(target.dataset.projectCommit){void projectCommit(target.dataset.projectCommit);return;}
  // What a Pip found and its fix, in its chat (src/pipFlow.js).
  if(target.dataset.flowFile){flowOpenFile(target.dataset.flowFile,target.dataset.flowLine);return;}
  if(target.dataset.flowAllow){void flowDecide(target.dataset.flowAllow,true);return;}
  if(target.dataset.flowNo){void flowDecide(target.dataset.flowNo,false);return;}
  if(target.dataset.flowMenu){flow.menu=flow.menu===target.dataset.flowMenu?'':target.dataset.flowMenu;render();if(flow.menu)document.querySelector('.pip-found-menu .dgc-menu-row')?.focus();return;}
  if(target.dataset.flowHelper){void flowHelper(target.dataset.flowHelper);return;}
  if(target.dataset.flowSteps){void openReplyTrace(target.dataset.flowSteps);return;}
  if(target.dataset.flowWatch){openComputerView();return;}
  if(target.dataset.flowStop){void flowStop(target.dataset.flowStop);return;}
  if(target.dataset.flowWaitingToggle!==undefined){flow.waitingOpen=!flow.waitingOpen;render();$('pip-waiting-toggle')?.focus({preventScroll:true});return;}
  if(target.dataset.flowWaitingAnswer){void flowWaitingAnswer(target.dataset.flowWaitingId,target.dataset.flowWaitingAnswer);return;}
  if(target.dataset.reportsSort){one.reportsSort=target.dataset.reportsSort==='old'?'old':'new';render();$('pip-reports-sort')?.focus({preventScroll:true});return;}
  if(target.dataset.projectDiscard){projectConfirm=target.dataset.projectDiscard;projectErrors.delete(projectConfirm);render();document.querySelector(`[data-project-keep="${projectConfirm}"]`)?.focus();return;}
  if(target.dataset.projectKeep){const id=target.dataset.projectKeep;projectConfirm='';render();document.querySelector(`[data-project-discard="${id}"]`)?.focus();return;}
  if(target.dataset.projectDiscardYes){void projectDecide('discard',target.dataset.projectDiscardYes);return;}
  if(target.dataset.projectUndo){void projectDecide('undo',target.dataset.projectUndo);return;}
  if(target.dataset.projectWork){void projectWork(target.dataset.projectWork);return;}
  if(target.dataset.projectComputer!==undefined){projectNeedsComputer='';projectRefused=false;grantComputer(true);return;}
  if(target.dataset.projectComputerNo!==undefined){projectNeedsComputer='';projectRefused=false;render();$('chatText')?.focus();return;}
  if(target.dataset.borrowAllow){void borrowAnswer('allow_pip_borrow',target.dataset.borrowAllow);return;}
  if(target.dataset.borrowDecline){void borrowAnswer('decline_pip_borrow',target.dataset.borrowDecline);return;}
  if(target.dataset.borrowStop){void borrowAnswer('stop_pip_borrow',target.dataset.borrowStop);return;}
  if(target.dataset.ownAppAccept){void acceptOwnAppUpdate(target.dataset.ownAppAccept,target.dataset.ownAppDigest||'');return;}
  if(target.dataset.pipKeyDecline){void pipKeyDecline(target.dataset.pipKeyDecline);return;}
  if(target.dataset.pipKeyAskRemove){const id=target.dataset.pipKeyAskRemove;pipKeyConfirm=id;S.pipKeysError='';render();$('pip-key-keep-'+id)?.focus();return;}
  if(target.dataset.pipKeyKeep!==undefined){const id=pipKeyConfirm;pipKeyConfirm='';render();$('pip-key-ask-'+id)?.focus();return;}
  if(target.dataset.pipKeyRemove){void pipKeyRemove(target.dataset.pipKeyRemove);return;}
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
  if(target.dataset.coreFlow){
    const suggestion=flowState.suggestions.find(s=>s.id===target.dataset.coreFlow);
    if(!suggestion||S.workspace?.kind!=='personal'||!suggestion.pips.every(p=>S.jobs.some(job=>job.id===p.pip_id&&job.status==='active')))return;
    flowDraft.name=(suggestion.pips[0].name+' workflow').slice(0,120);
    flowDraft.mode='reviewed';flowDraft.count=suggestion.pips.length;
    flowDraft.pips=[...suggestion.pips.map(p=>p.pip_id),'','',''].slice(0,4);
    flowDraft.tasks=['','',''];flowState.form=true;flowState.error='';render();$('flow-task-0')?.focus();return;
  }
  if(target.dataset.flowHandoff){
    const flow=flowState.flows.find(f=>f.id===target.dataset.flowHandoff),step=flow?.steps?.[0];
    const pipId=flow?.definition?.pips?.[step?.stage+1]?.pip_id;
    if(!step?.handoff_id||step.handoff_status!=='pending'||!pipId||!S.jobs.some(p=>p.id===pipId))return;
    void (async()=>{try{await select(pipId);S.tab='handoffs';rememberView();render();await loadHandoffs();await openSavedHandoff(step.handoff_id);}catch(error){setError(error);}})();return;
  }
  if(target.dataset.flowStatus){
    const flow=flowState.flows.find(f=>f.id===target.dataset.flowStatus&&f.revision===Number(target.dataset.flowRevision));
    const status=target.dataset.flowNext;
    if(!flow||!['on','paused','retired'].includes(status))return;
    openReview({title:status==='retired'?'Remove workflow?':status==='paused'?'Pause workflow?':'Resume workflow?',description:status==='retired'?'Past handoff receipts remain, but this workflow cannot run again.':status==='paused'?'Future handoffs stop. Runs already queued may finish.':'New runs can start the exact approved Pip sequence again.',confirm:status==='retired'?'Remove':status==='paused'?'Pause':'Resume',danger:status==='retired',request:{type:'set_pip_flow',flow_id:flow.id,expected_revision:flow.revision,status}});return;
  }
  switch(target.id){
    case 'workspace-notifications':leaveForProjectPage();S.tab='notifications';S.overview=false;S.create=false;rememberView();render();void loadNotifications();break;
    case 'refresh-notifications':void loadNotifications();break;
    case 'more-notifications':void loadNotifications(true);break;
    case 'workspace-context':leaveForProjectPage();S.tab='context';S.overview=false;S.create=false;rememberView();render();if(S.apiVersion>=12){if(!outcomeSessionsLoaded)void loadOutcomeSessions();if(!outcomeLoaded)void loadOutcomes();}break;
    case 'load-outcome-sessions':void loadOutcomeSessions();break;
    case 'more-outcome-sessions':void loadOutcomeSessions(true);break;
    case 'inspect-outcome-session':void inspectOutcomeSession();break;
    case 'use-outcome-run':if(S.run?.status==='succeeded'){draft.outcomeSourceValue=S.run.id;render();}break;
    case 'load-command-receipts':void loadCommandReceipts();break;
    case 'more-command-receipts':void loadCommandReceipts(true);break;
    case 'load-outcomes':void loadOutcomes();break;
    case 'more-outcomes':void loadOutcomes(true);break;
    case 'reconnect':S.connectFailed=false;waitForConnection();render();vscode.postMessage({type:'pipsReconnect'});break;
    case 'enable':if(!remoteHost)void enable();break;
    case 'new-pip':case 'create-first':if(simpleMode()&&projectHome()){openNewPip();break;}setupEditing=false;rememberCreationDraft();S.create=true;S.overview=false;S.createStep=S.apiVersion>=23?'describe':'type';S.tab='runs';S.error='';render();($('setupTask')||document.querySelector('[data-pip-type]:not(:disabled)'))?.focus();void loadModels();break;
    case 'advanced-create':if(simpleMode()&&projectHome()){S.create=false;S.overview=!(setupEditing&&S.selected);setupEditing=false;render();openNewPip();break;}S.createStep='type';render();document.querySelector('[data-pip-type]:not(:disabled)')?.focus();break;
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
    case 'import-pip-file':if(S.review?.onePip){void oneLeaveForFolder(()=>void importPipFile());break;}if(S.review?.projectPip)closeReview();void importPipFile();break;
    case 'export-pip-file':void exportPipFile();break;
    case 'refresh-findings':outcomeState.pip='';void loadFindingOutcomes();break;
    case 'back-types':rememberCreationDraft();S.createStep='type';render();[...document.querySelectorAll('[data-pip-type]')].find(b=>b.dataset.pipType===S.createType)?.focus();break;
    case 'cancel-create':case 'create-back':rememberCreationDraft();S.create=false;
      // On the simple page a new Pip's page goes back to the list it came from; Change in chat, to its Pip.
      S.overview=simpleMode()&&projectHome()?!(setupEditing&&S.selected):!S.selected;setupEditing=simpleMode()&&projectHome()?false:setupEditing;rememberView();render();if(onePips()&&S.overview)oneHomeAgain();break;
    case 'new-pip-describe':if(S.apiVersion<23)break;
      if(S.review?.onePip){void oneLeaveForFolder(()=>{rememberCreationDraft();setupEditing=false;S.create=true;S.overview=false;S.createStep='describe';S.error='';render();$('setupTask')?.focus();});break;}
      closeReview();rememberCreationDraft();setupEditing=false;S.create=true;S.overview=false;S.createStep='describe';S.error='';render();$('setupTask')?.focus();break;
    case 'new-pip-back':openNewProjectPip();break;
    case 'workspace-back':S.overview=true;S.tab='chat';rememberView();render();break;
    case 'pip-run-now':if(runAction()&&!runBlocked())runNow();break;
    case 'pip-run-open':{const id=target.dataset.runId;S.tab='runs';S.overview=false;rememberView();render();void loadSelected(false).then(()=>{if(id&&S.tab==='runs')return loadRun(id);});break;}
    case 'back-pips':chatDrafts.set(S.selected,draft.chatText);if(!S.selected)S.tab='chat';S.overview=true;rememberView();render();break;
    case 'return-main':options.close?.();break;
    case 'pip-to-latest':chatFollow.latest();break;
    case 'chat-model':S.composerPanel=S.composerPanel==='model'?'':'model';S.modelListOpen=true;S.modelTab='main';S.modelCustom='';S.fallbackMenu='';if(S.composerPanel)void loadPipBackup();S.modelProviderView=false;S.modelProviderChoice=currentChatProvider(modelValue(S.pip?.model_choice));S.composerNoteOpen=false;render();if(S.composerPanel){if(!S.models.length)void loadModels();$('chat-model-summary')?.focus();const chosen=document.querySelector('.composer-model-options [aria-selected="true"]'),list=chosen?.closest('.composer-model-options');if(list)list.scrollTop=Math.max(0,chosen.offsetTop-list.offsetTop-list.clientHeight/2);}break;
    case 'chat-model-summary':if(S.modelTab==='agents'){S.modelTab='main';S.modelListOpen=true;S.modelProviderView=false;render();$('chat-model-providers')?.focus();break;}S.modelListOpen=!S.modelListOpen;S.modelProviderView=false;render();(S.modelListOpen?$('chat-model-providers'):$('chat-model-summary'))?.focus();break;
    case 'chat-model-providers':S.modelProviderView=true;render();[...document.querySelectorAll('[data-chat-provider]')].find(node=>node.dataset.chatProvider===S.modelProviderChoice)?.focus();break;
    case 'chat-model-close':S.composerPanel='';render();$('chat-model')?.focus();break;
    case 'chat-context-toggle':S.composerPanel=S.composerPanel==='context'?'':'context';S.composerNoteOpen=false;render();if(S.composerPanel){void loadChatContext();$('chat-context')?.focus();}break;
    case 'chat-context-close':S.composerPanel='';render();$('chat-context-toggle')?.focus();break;
    case 'chat-routines':S.composerPanel=S.composerPanel==='routines'?'':'routines';render();if(S.composerPanel){if(!S.routines)void loadRoutines();$('chat-routines-close')?.focus();}break;
    case 'chat-routines-close':S.composerPanel='';render();$('chat-routines')?.focus();break;
    case 'chat-refresh-models':void loadModels();break;
    case 'chat-permissions':S.composerPanel='';render();openWhatItCanDo();break;
    case 'older-messages':void loadMessages(true);void loadPosts(true);break;
    case 'refresh-models':void loadModels();break;
    case 'add-computer':void addComputer();break;
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
    case 'delete-archived-pip':reviewPermanentDelete();break;
    case 'delete-archived-pip-menu':reviewPermanentDelete();break;
    case 'show-archived':S.showArchived=!S.showArchived;render();break;
    case 'pips-more':void loadMorePips();break;
    case 'cancel-run':openReview({title:personalPip()?'Stop this?':'Cancel this run?',description:personalPip()?`${S.pip?.name||'It'} stops what it’s doing. It can take a moment.`:'It stops what it’s doing. It can take a moment.',body:'',confirm:personalPip()?'Stop':'Cancel run',danger:true,request:{type:'cancel_pip_run',run_id:S.runId}});break;
    case 'stop-all':openReview({title:'Stop all Pips?',description:'Every Pip on this computer pauses and stops what it’s doing. They stay stopped after DGC restarts.',body:'<p class="muted">To undo it: Resume Pips, then resume each Pip.</p>',confirm:'Stop all Pips',danger:true,request:{type:'stop_pips'}});break;
    case 'start-runner':if(remoteHost)break;void mutate({type:'pips_runtime',action:'start'});break;
    case 'keep-running-refresh':if(remoteHost||!keepState.value?.outdated)break;void setKeepRunning(true,true);break;
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
    // New Pip over the list of every project's: in this window's project, with its form's folder field to change it.
    case 'projects-new':{const space=windowSpace();if(space&&!S.busy&&usable())void enterWorkspace(space).then(()=>{if(S.workspace?.id===space.id)openNewProjectPip();});break;}
    case 'team-export':target.closest('details')?.removeAttribute('open');openTeamExport();break;
    case 'team-import':target.closest('details')?.removeAttribute('open');void importTeam();break;
    case 'team-import-github':target.closest('details')?.removeAttribute('open');openGithubImport();break;
    case 'team-import-grok':target.closest('details')?.removeAttribute('open');void openGrokImport();break;
    case 'import-prompt-copy':copyImportPrompt();break;
    case 'flow-new':flowDraft.name='';flowDraft.mode='reviewed';flowDraft.count=3;flowDraft.pips=['','','',''];flowDraft.tasks=['','',''];flowState.form=true;flowState.error='';render();$('flow-name')?.focus();break;
    case 'flow-cancel':flowState.form=false;flowState.error='';render();break;
    case 'create-core':void createSimplePip('core','Core');break;
    case 'simple-back':chatDrafts.set(S.selected,draft.chatText);S.overview=true;rememberView();render();if(onePips())oneHomeAgain();void loadFlows();break;
    case 'one-more':void loadOneMore();break;
    case 'pips-how':options.onHowPipsWork?.();break;
    case 'pips-settings-open':pipsSettings.view=pipsSettings.view||'computer';pipsSettings.confirmReset='';render();void loadPipsSettings();break;
    case 'pips-settings-close':pipsSettings.view='';render();break;
    case 'pip-page-back':S.pipPage='info';lookDirty=false;render();void loadRoutines();break;
    case 'simple-to-chat':S.tab='chat';rememberView();render();void loadMessages();break;
    case 'pip-computer-open':{
      // The Pip's computer, one tap from its chat: open its screen, or offer it one.
      if(S.apiVersion<42||!personalPip()||archived())break;
      // With more than one (Pips API 86), a menu under the icon asks which.
      if(computerUi().menu){closeComputerMenu();break;}
      const open=()=>{if(computerState.pip!==S.selected||!computerState.value)return;if(!computerState.value.granted)grantComputer(true);else if(severalComputers())openComputerMenu();else void openComputerView();};
      if(computerState.pip===S.selected&&computerState.value)open();else void loadComputer().then(open);
      break;}
    case 'edit-goal':S.editingGoal=true;draft.revisionGoal=S.pip?.goal||'';render();$('revisionGoal')?.focus();break;
    case 'cancel-goal':S.editingGoal=false;draft.revisionGoal='';render();break;
    case 'review-confirm':{
      const review=S.review;if(!review||review.scope!==scope()||!usable())return;
      if(review.run){void runReview(review);return;}
      if(review.emailDraft){void chooseMessageConnection(review.emailDraft,review.calendarAction===true);return;}
      if(review.savedConnectorDraft){void chooseConnectorTool(review.savedConnectorDraft.payload.action.server,review.savedConnectorDraft);return;}
      if(review.connectorForm){prepareConnector(review);return;}
      if(review.projectPip){createProjectPip(review);return;}
      if(review.teamExport){void exportTeam(review);return;}
      if(review.sourceImport){if(!reviewBlocked(review))void importSource(review);return;}
      if(review.onePip){void createOnePip(review);return;}
      if(review.fullLevel){const back=review.refocus;closeReview();void setLevel('full',{refocus:back});return;}
      if(review.newPip){void createSimplePip(draft.newPipCharacter,draft.newPipName,review);return;}
      if(review.computerGrant!==undefined){void applyComputerGrant(review);return;}
      if(review.computerAction){if(!reviewBlocked(review))void decideComputerAction(review,true);else{review.error='This action expired. Nothing was sent.';renderReview();}return;}
      if(review.messageForm){prepareMessage(review);return;}
      if(review.appPicker){prepareAppReview(review);return;}
      if(review.starterForm){prepareStarter(review);return;}
      if(review.setup){void resolveSetup(review);return;}
      if(reviewBlocked(review)){review.error='This expired or was changed. Refresh and try again.';renderReview();return;}
      if(review.permanentPip){void confirmPermanentDelete(review);return;}
      if(review.rejectFirst?.length){void rejectWaitingThenConfirm(review);return;}
      let reason;if(review.reasonRequired){reason=(review.note&&draft.findingReviewReason.trim())||review.autoReason||'Decided in the Pips view.';if(new TextEncoder().encode(reason).length>1000){review.error='That note is too long. Keep it under 1,000 characters (fewer with emoji or non-English text).';renderReview();$('findingReviewReason')?.focus();return;}}
      let memoryArgs={};if(review.lifecycle){const body=JSON.stringify({reason});if(review.lifecycleRetry?.body!==body)review.lifecycleRetry={body,key:window.crypto.randomUUID()};memoryArgs={request_key:review.lifecycleRetry.key};}
      if(review.memoryRecord){
        const raw=draft.memoryExpiry.trim();let expiry=null;if(raw){if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(raw)||Number.isNaN(Date.parse(raw))||Date.parse(raw)<=Date.now()){review.error='Enter a future time with seconds and an explicit offset or Z.';renderReview();return;}expiry=new Date(raw).toISOString();}
        const keyBody=JSON.stringify({reason,expiry});if(review.memoryRetry?.body!==keyBody)review.memoryRetry={body:keyBody,key:window.crypto.randomUUID()};memoryArgs={expires_at:expiry,request_key:review.memoryRetry.key};
      }
      void mutate({...review.request,...(reason?{reason}:{}),...memoryArgs},async result=>{
        if(['create_pip_flow','set_pip_flow'].includes(review.request.type)){
          const flow=result.flow;
          if(!record(flow)||flow.workspace_id!==S.workspace.id||flow.id!==review.request.flow_id&&review.request.type==='set_pip_flow'||flow.status!==(review.request.type==='create_pip_flow'?'on':review.request.status))throw Error('Workflow receipt does not match the review. Refresh and try again.');
          flowState.form=false;flowState.loaded=false;flowState.error='';S.notice=review.request.type==='create_pip_flow'?'Workflow created. Its next start follows the routing mode you approved.':flow.status==='on'?'Workflow resumed.':flow.status==='paused'?'Workflow paused.':'Workflow removed.';
          void loadFlows();return;
        }
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
          // A user: archiving "takes me back to its chat, it should just take me to Pips home".
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
        if(['accept_pip_update','reject_pip_update'].includes(review.request.type)){updateDecided(review,result);return;}
        S.notice=review.request.type==='review_pip_finding'?'Saved. Workspace context didn’t change.':review.request.type==='stop_pips'?'All Pips are stopping.':review.request.type==='pips_enable'?'Pips are off.':'Saved.';
      });break;
    }
  }
});
document.addEventListener('click',event=>{const img=event.target.closest?.('#computer-screen');if(!img||!img.dataset.width||!S.review?.computerView)return;const r=img.getBoundingClientRect();if(!r.width||!r.height)return;void computerView('click',{x:Math.round((event.clientX-r.left)*Number(img.dataset.width)/r.width),y:Math.round((event.clientY-r.top)*Number(img.dataset.height)/r.height)});});
document.addEventListener('click',event=>{const server=event.target.closest?.('[data-app-connection]')?.dataset.appConnection;if(server)void chooseAppAccount(server);});
// A reply's details open below it. At the bottom of the conversation that is out of sight, so the panel comes into view
// (only as far as it must). A click, not the toggle: each redraw opens the panels left open, and must not scroll.
document.addEventListener('click',event=>{const details=event.target.closest?.('details.message-details > summary')?.parentElement;if(!details)return;requestAnimationFrame(()=>{const provenance=details.open&&details.querySelector('.message-provenance');if(provenance)revealInChat(provenance,'nearest');});});
document.addEventListener('change',event=>{if(event.target.id==='app-window-mode'){const relative=event.target.value==='calendar_days';$('app-relative-window').hidden=!relative;$('app-fixed-window').hidden=relative;}if(event.target.id==='app-account'&&S.review?.appPicker){const choice=S.review.appPicker.choices[Number(event.target.value)];$('app-calendar-window').hidden=event.target.value===''||choice?.toolkit!=='googlecalendar';const extra=extraReadTools.includes(choice?.tool);$('app-query').placeholder=({googledrive:'File name, for example Budget',notion:'Page title, for example Reading',googlecontacts:'Name, for example Alex',googlecalendar:'Optional event search',gmail:'For example: is:unread'})[choice?.toolkit]||'';$('app-query-label').textContent=extra?'Name or title to search (required)':'Search query (optional)';$('app-read-notice').textContent=appReadNotices[choice?.toolkit]||'';$('app-query').required=extra;}});
async function enable(){
  if(!S.connected||!S.supported||S.busy)return;const epoch=S.epoch;S.busy=true;render();
  try{const result=await send('pips_enable',{enabled:true});if(epoch!==S.epoch||!S.connected)return;S.enabled=result.enabled===true;S.notice=result.message||'Local Pips enabled.';if(S.enabled)await initialize();}
  catch(error){if(epoch===S.epoch)setError(error);}finally{if(epoch===S.epoch){S.busy=false;render();}}
}
document.addEventListener('focusout',event=>picker.focusout(event));
// A Pip's title, left as it was saved: its box is the quiet link again (with a change typed, Save and Cancel decide).
document.addEventListener('focusout',event=>{if(event.target?.id!=='pipPageTitle'||!titleEditing||pageNameDirty||disposed)return;titleEditing=false;render();});
document.addEventListener('mousemove',event=>picker.hover(event));
// The thinking slider's focus ring is for the keyboard, on the Pip's face. Dragging it draws nothing (reported 2026-11-07). A
// redraw keeps which it was, since a choice redraws the composer under the slider.
const markEffortInput=byKeys=>{effortByKeys=byKeys;for(const node of [document,...[document.querySelector('#pips-host')?.shadowRoot].filter(Boolean)])node.getElementById?.('chat-thinking')?.classList.toggle('by-keys',byKeys);};
// The slider follows the pointer while it's held: its face, fill and word move with it, and the choice is saved on release.
const pathTarget=event=>event.composedPath?.()[0]||event.target;
const followEffort=input=>{const most=Number(input.max)===5?5:4,step=Math.max(0,Math.min(most,Number(input.value)||0)),control=input.closest?.('.composer-effort-control');
 if(!control)return;control.dataset.step=String(step);control.style.setProperty('--effort-t',String(step/most));
 const word=step===5?'Ultra':EFFORT_NAME[chatThinkingLevels[step]]||chatThinkingLevels[step];input.setAttribute('aria-valuetext',step===5?'Ultra: up to 4 sub-agents at once':word);
 const out=control.querySelector('output');if(out)out.textContent=word;
 const labels=control.querySelector('.composer-effort-labels');if(labels)labels.dataset.at=step===0?'start':step===most?'end':'';control.dataset.full=step===most?'1':'0';};
const releaseEffort=()=>{if(!effortHeld)return;effortHeld=false;if(effortRedraw){effortRedraw=false;render();}};
if(typeof document!=='undefined'){document.addEventListener('pointerdown',event=>{if(pathTarget(event)?.id==='chat-thinking')effortHeld=true;},true);
 document.addEventListener('pointerup',releaseEffort,true);document.addEventListener('pointercancel',releaseEffort,true);
 document.addEventListener('input',event=>{const t=pathTarget(event);if(t?.id==='chat-thinking')followEffort(t);},true);}
if(typeof document!=='undefined'){document.addEventListener('pointerdown',()=>markEffortInput(false),true);document.addEventListener('keydown',event=>{if(event.key==='Tab'||event.composedPath?.()[0]?.id==='chat-thinking')markEffortInput(true);},true);}
// The page of them all: the card you last pressed or reached with the keyboard is the one Needs attention shows when you go back.
{const onCard=event=>{if(!attentionAll.open)return;const li=event.target.closest?.('.attention-all-list>[data-attention-key]');if(li){attentionAll.last=li.dataset.attentionKey;attentionAll.lastIndex=Number(li.dataset.attentionIndex)||0;}};
 document.addEventListener('focusin',onCard);document.addEventListener('pointerdown',onCard);}
// A sideways swipe on Needs attention's card goes one card along: a finger or a pen across it, or two fingers on a
// trackpad (one card a swipe: the rest of its glide is let pass).
{let from=null,glide=0,passed=0,moved=false;
 document.addEventListener('pointerdown',event=>{from=event.pointerType!=='mouse'&&event.isPrimary!==false&&event.target.closest?.('.attention-stage')?{x:event.clientX,y:event.clientY,id:event.pointerId}:null;});
 document.addEventListener('pointerup',event=>{const start=from;from=null;if(!start||start.id!==event.pointerId)return;
  const dx=event.clientX-start.x,dy=event.clientY-start.y;if(Math.abs(dx)>=40&&Math.abs(dx)>Math.abs(dy)*1.5)attentionStep(dx<0?1:-1);});
 document.addEventListener('pointercancel',()=>{from=null;});
 const onWheel=event=>{
  if(!event.target.closest?.('.attention-stage')||Math.abs(event.deltaX)<=Math.abs(event.deltaY))return;
  const now=Date.now(),resting=now-passed>200;passed=now;if(resting){glide=0;moved=false;}
  if(moved)return;glide+=event.deltaX;if(Math.abs(glide)>=60){moved=true;attentionStep(glide>0?1:-1);}
 };
 root.addEventListener('wheel',onWheel,{passive:true});disposers.push(()=>root.removeEventListener('wheel',onWheel));}
document.addEventListener('keydown',event=>{
  if(picker.keydown(event))return;
  // The model menu's two tabs: Left and Right move between them, and choose (as Work's do).
  {const tab=event.target.closest?.('.composer-model-menu [data-model-tab]');if(tab&&(event.key==='ArrowLeft'||event.key==='ArrowRight')){event.preventDefault();event.stopPropagation();const to=tab.dataset.modelTab==='main'?'agents':'main';S.modelTab=to;if(to==='main')S.modelListOpen=true;render();$(`chat-model-tab-${to}`)?.focus();return;}}
  if(!S.review&&allowFromOpen){const row=event.target.closest?.('.allow-from'),menu=row?.querySelector('.allow-from-menu');
   if(menu&&menu.contains(event.target)){if(globalThis.DgcMenu?.handle(menu,event,{rows:'.dgc-menu-row',close:()=>{allowFromOpen='';render();},trigger:()=>document.querySelector(`[data-allow-from="${menu.dataset.allowFromMenu}"]`)}))return;}
   else if(row&&event.key==='Escape'){event.preventDefault();event.stopPropagation();closeAllowFrom(true);return;}
   else if(row&&event.key==='ArrowDown'&&menu){event.preventDefault();menu.querySelector('.dgc-menu-row')?.focus();return;}}
  if(!S.review&&folderUi.open){const set=event.target.closest?.('.pip-folder-set'),menu=set?.querySelector('.pip-folder-menu');
   if(menu&&menu.contains(event.target)){if(globalThis.DgcMenu?.handle(menu,event,{rows:'.dgc-menu-row',close:()=>{folderUi.open=false;render();},trigger:()=>$('pip-folder-btn')}))return;}
   else if(set&&event.key==='Escape'){event.preventDefault();event.stopPropagation();closeFolderMenu(true);return;}
   else if(set&&event.key==='ArrowDown'&&menu){event.preventDefault();menu.querySelector('.dgc-menu-row')?.focus();return;}}
  if(!S.review&&folderUi.adding&&event.key==='Escape'&&event.target.id==='pipFolderName'){event.preventDefault();event.stopPropagation();folderUi.adding=false;folderUi.error='';draft.pipFolderName='';render();$('pip-folder-btn')?.focus({preventScroll:true});return;}
  if(!S.review&&convKeydown(event))return;
  if(!S.review&&computerKeydown(event))return;
  if(!S.review&&DgcCard.key(event)){event.preventDefault();return;}   // Esc closes a card's open detail
  // Needs attention's page of them all: Escape goes back, as its back button does. (A card's open detail closed first, above.)
  if(!S.review&&event.key==='Escape'&&!event.defaultPrevented&&attentionAllShown()&&document.querySelector('.attention-all')&&!event.target.matches?.('input,textarea,select,[contenteditable]')){event.preventDefault();closeAttentionAll();return;}
  // Needs attention's one card: with the keyboard anywhere in it, an arrow goes to the next card or back, Home and
  // End to the first and the last. Not from a box you type in.
  if(!S.review&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.target.matches?.('input,textarea,select,[contenteditable]')){
   const carousel=event.target.closest?.('.attention-carousel');
   if(carousel&&Number(carousel.dataset.count)>1){event.preventDefault();
    if(event.key==='Home')attentionGo(carousel.dataset.first,0,{focus:true});else if(event.key==='End')attentionGo(carousel.dataset.last,Number(carousel.dataset.count)-1,{focus:true});
    else attentionStep(event.key==='ArrowLeft'?-1:1,{focus:true});return;}
  }
  // Personal | Project keys, as the Sessions home's tabs take them: an arrow goes to the other tab, Home and End to
  // the first and the last, and the tab chosen takes the focus.
  if(!S.review&&event.target.dataset?.pipsTab&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();chooseScopeTab(event.key==='Home'?'personal':event.key==='End'?'project':scopeTab()==='personal'?'project':'personal',true);return;}
  if(event.target.id==='chat-model-custom'){
   if(event.key==='Enter'){event.preventDefault();const name=event.target.value.trim();if(name)reviewChatModel(`${event.target.dataset.modelProvider}:${name}`);return;}
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();S.modelCustom='';render();$('chat-model-providers')?.focus();return;}
  }
  // A Pip's page menus (the "…" and More): the keys every menu answers (media/shared/menu.js). Down from the open menu's
  // button goes into it; Escape closes it and returns to that button.
  const opened=event.target.closest?.('details[open]'),pageMenu=opened?.querySelector(':scope > .tabs-menu.dgc-menu');
  if(!S.review&&pageMenu&&globalThis.DgcMenu){
   const summary=opened.querySelector(':scope > summary');
   if(event.target===summary&&event.key==='ArrowDown'){const first=pageMenu.querySelector('button:not(:disabled)');if(first){event.preventDefault();first.focus();return;}}
   else if(pageMenu.contains(event.target)&&globalThis.DgcMenu.handle(pageMenu,event,{rows:':scope > button',close:()=>opened.removeAttribute('open'),trigger:summary}))return;
  }
  // The Controls menu on the list of Pips (the "…" beside Start): Escape closes it and returns to its button, as a Pip's
  // page menus do above. It holds switches and buttons, not rows, so the arrows are left to them.
  const controlsMenu=event.key==='Escape'&&!S.review?event.target.closest?.('details.runner-controls[open]'):null;
  if(controlsMenu&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();controlsMenu.removeAttribute('open');controlsMenu.querySelector(':scope > summary')?.focus();return;}
  if(!S.review&&S.composerPanel){if(event.key==='Escape'){event.preventDefault();const target=S.composerPanel==='context'?'chat-context-toggle':S.composerPanel==='routines'?'chat-routines':S.composerPanel==='add'?'chat-attach':S.composerPanel==='level'?'chat-level':'chat-model';S.composerPanel='';render();$(target)?.focus();return;}const menu=event.target.closest?.('.dgc-menu');if(menu&&globalThis.DgcMenu?.handle(menu,event,{rows:'.dgc-menu-row'}))return;}
  if(event.key==='Escape'&&voiceMode?.active){event.preventDefault();voiceMode.end();return;}
  if(event.key==='Escape'&&(S.mic==='recording'||S.mic==='starting')){event.preventDefault();micCancel();return;}
  if(!S.review&&event.target.id==='chatText'&&event.key==='Enter'&&!event.isComposing){
    event.preventDefault();
    if(event.altKey&&!event.shiftKey&&(S.chatActiveRun||S.sending)){queueChatMessage();return;}
    if(!event.shiftKey){void sendChat();return;}
    const box=event.target,next=window.DgcNumberedList?.continuation(box.value,box.selectionStart,box.selectionEnd)||'\n';
    chatEdit(()=>box.setRangeText(next,box.selectionStart,box.selectionEnd,'end'));
    box.dispatchEvent(new Event('input',{bubbles:true}));
    fitChatInput();return;
  }
  if(!S.review)return;
  if(event.key==='Escape'&&!S.busy){event.preventDefault();closeReview();return;}
  if(event.key==='Enter'&&!event.isComposing&&event.target.id==='importLink'&&S.review.sourceImport){event.preventDefault();$('review-confirm')?.click();return;}
  if(event.key==='Tab'){
    const items=[...$('review-root').querySelectorAll('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')];if(!items.length){event.preventDefault();return;}
    const first=items[0],last=items[items.length-1];if(event.shiftKey&&(document.activeElement===first||document.activeElement===$('review-title'))){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
});
document.addEventListener('mouseover',event=>{if(event.target?.closest?.('.pips-one-list')){window.clearTimeout(one.leave);one.hover=true;}});
document.addEventListener('mouseout',event=>{
  if(!one.hover||!event.target?.closest?.('.pips-one-list')||event.relatedTarget?.closest?.('.pips-one-list'))return;
  // (A redraw under the pointer takes the row away for a moment: the pointer coming back over the list keeps the hold.)
  window.clearTimeout(one.leave);one.leave=window.setTimeout(()=>{one.hover=false;oneRelease();},120);
});
document.addEventListener('focusout',event=>{if(event.target?.closest?.('.pips-one-list'))window.setTimeout(oneRelease,0);});
const stopMessages=options.onMessage(message=>{
  if(disposed||!record(message))return;
  // What is pinned to the dock (src/dock.ts): each Pip's row shows its pin filled or not.
  if(message.type==='dock'){
   const keys=Array.isArray(message.pinned)?message.pinned:Array.isArray(message.pins)?message.pins.map(pin=>pin?.key):[];
   const next=new Set(keys.filter(key=>typeof key==='string')),same=next.size===dockPins.size&&[...next].every(key=>dockPins.has(key));
   dockPins=next;dockKnown=true;if(!same&&S.overview&&!S.review)render();return;
  }
  if(window.DgcVideo?.message(message))return;     // a reply video's bytes or state (src/videoHost.ts)
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
  if(message.type==='pipsReply'){broker.receive(message);if(message.ok===true)window.setTimeout(clearBusy,0);return;}
  if(globalThis.DgcPictureFold?.message(message))return;     // which pictures stay folded, and the setting
  if(message.type==='pipsPluginLogos'){takePluginLogos(message.logos);return;}
  if(message.type==='pipsAppLogos'){takePluginLogos(message.logos,true);return;}
  if(message.type==='pipsFiles'){projectFiles=(Array.isArray(message.files)?message.files:[]).filter(f=>record(f)&&typeof f.label==='string').slice(0,600);chatPicker?.refresh();return;}
  // Settings or the Router changed: Default may run somewhere else now. A list already read is read again.
  // A Pip was marked read somewhere else (its pill on the home, a card in a Work chat): the counts are read again.
  if(message.type==='pipsUnreadChanged'){lastUnreadAt=0;void loadUnread(true);if(convOn()&&S.tab==='chat'&&S.selected)void loadFlow();return;}   // (a Pips event: its fixes and sub-agents are read again)
  if(message.type==='pipsProfileChanged'){void refresh(false);return;}
  if(message.type==='pipSetupChanged'){void refresh(false);return;}
  // The Project Folder choice changed (here, over the Work sessions, in another window): the Project tab and Needs
  // attention follow it. And the folder the editor's picker gave for Add a folder… (null: closed without one).
  if(message.type==='pipsProjectFolder'){
   if(typeof S.projectFolder==='string'&&typeof message.folder==='string'&&message.folder!==S.projectFolder){
    S.projectFolder=message.folder;projectsAll.read=false;globalThis.DgcFolderPick?.close();render();
    void loadFolders().then(()=>{void loadAttention();render();});}
   return;}
  if(message.type==='pipsFolderPicked'){const done=folderPicks.get(message.id);if(done){folderPicks.delete(message.id);done(typeof message.folder==='string'&&message.folder?message.folder:null);}return;}   // a new-Pip card decided in a chat: Needs attention follows
  if(message.type==='pipsModelsChanged'){if(usable()&&(S.models.length||S.defaultModel||S.router)&&!S.modelsLoading)void loadModels();return;}
  if(message.type==='pipsVisibility'){const back=S.focused===false&&message.focused!==false;if(typeof message.focused==='boolean')S.focused=message.focused;S.visible=message.visible===true;motion();if(S.visible)void refresh(false);if(back)maybeMarkRead();return;}
  if(message.type==='pipsConnection'){
    if(message.generation !== undefined && message.generation === S.generation) return;
    S.generation=message.generation ?? null;S.displayMentions=message.displayMentions===true;
    S.connectFailed=message.connected!==true&&message.failed===true;S.jobsRead=false;
    savedView=options.getState?.()||savedView;S.epoch++;broker.reset();clearSelection();S.selected='';S.overview=true;restoreView=true;convShown.clear();convStash.clear();convDrafts.clear();convState.pip='';convState.list=null;chatDrafts.clear();chatMarks.clear();chatRequests.clear();chatPreferences.clear();draft.chatText='';chatHistory?.reset();S.workspace=null;S.projectEmpty=false;S.switching=false;S.currentWorkspaceId=null;S.folderOpen=message.folder!==false;S.jobs=[];S.jobsRead=false;setupSeq++;setupDetailSeq++;setupRows=[];setupLoading=false;setupError='';draft.setupTask='';S.types=[];S.models=[];S.defaultModel='';S.subscriptions=[];S.defaultEngine=null;S.router=null;S.modelsError='';S.modelsLoading=false;S.executionCapability=null;S.executionLoading=false;S.executionError='';draft.createModel='default';S.create=false;S.createStep='type';S.createType='';creationDrafts.clear();avatarIds.clear();S.runner=null;S.context=null;S.refreshing=false;S.busy=false;S.loading=false;S.error='';S.notice='';S.apiVersion=Number.isSafeInteger(message.apiVersion)?message.apiVersion:9;S.connected=message.connected===true;S.supported=message.supported===true;S.enabled=message.enabled===true;
    // The Project Folder dropdown, where the extension says what is chosen (a DGC that lists folders, Pips API 93).
    S.projectFolder=S.apiVersion>=93&&typeof message.projectFolder==='string'?message.projectFolder:null;S.folders=null;S.homeDir=typeof message.home==='string'?message.home:'';
    S.windowFolder=record(message.windowFolder)&&typeof message.windowFolder.folder==='string'&&message.windowFolder.folder?{folder:message.windowFolder.folder,name:typeof message.windowFolder.name==='string'?message.windowFolder.name:''}:null;
    projectsAll={pips:[],read:false,busy:false,error:'',seq:projectsAll.seq+1};Object.assign(one,{filter:ONE_ALL,pips:[],read:false,busy:false,error:'',seq:one.seq+1,next:null,total:null,moreBusy:false,held:null,drawn:null,hover:false,asked:''});one.bumps.clear();oneSeen.clear();oneSeenRead=false;resetFlow();addedFolders.clear();for(const done of folderPicks.values())done(null);folderPicks.clear();draft.createFolder='';globalThis.DgcFolderPick?.close();
    waitForConnection();render();if(usable())void initialize();
  }
});
disposers.push(stopMessages);
disposers.push(()=>window.clearTimeout(connectTimer));
const onPageHide=()=>{avatarObserver?.disconnect();avatarObserver=null;};window.addEventListener('pagehide',onPageHide);disposers.push(()=>window.removeEventListener('pagehide',onPageHide));
function motion(){document.body.classList.toggle('motion-paused',!S.visible||document.hidden||motionPaused);}
document.addEventListener('visibilitychange',()=>{motion();if(!document.hidden){fitChatInput();void refresh(false);}});
if(typeof ResizeObserver==='function'){const observer=new ResizeObserver(fitChatInput);observer.observe(shell);disposers.push(()=>observer.disconnect());}
// One bounded polling loop for the entire tab, paused while hidden; no timers per avatar or job.
const pollingTimer=window.setInterval(()=>{broker.expire(Date.now());if(polling||!S.visible||document.hidden||!usable()||S.busy||S.review||S.create||!['runs','chat'].includes(S.tab))return;polling=true;void refresh(false).finally(()=>{polling=false;});},4000);
motion();render();waitForConnection();vscode.postMessage({type:'pipsReady'});
return {async navigate(value){attentionAll.open=false;   // the host asks for another page: not Needs attention's own
 if(value?.overview===true){if(!S.workspace||!usable()){options.navigation=value;navigationPending=true;S.overview=true;return;}await navigateFromHost(value);return;}if(!S.workspace||!usable()){options.navigation=value;navigationPending=true;return;}try{await refresh(false);await navigateFromHost(value);}catch(error){setError(error);}},focusInside(){const box=chatBox?.el?.isConnected?chatBox.el:pageBack();try{box?.focus({preventScroll:true});}catch{}},setMotionPaused(paused){motionPaused=paused===true;motion();},setVisible(visible){S.visible=visible===true;motion();if(S.visible)void refresh(false);},setFocused(focused){const back=S.focused===false&&focused!==false;S.focused=focused!==false;if(back)maybeMarkRead();},dispose(){if(disposed)return;disposed=true;window.clearTimeout(noticeTimer);window.clearTimeout(appLinkTimer);S.epoch++;broker.reset();window.clearInterval(pollingTimer);window.clearInterval(workingClock);window.clearTimeout(streamTimer);window.clearTimeout(liveTimer);avatarObserver?.disconnect();characterCleanup?.();characterCleanup=null;for(const dispose of disposers)dispose?.();characterStyles.remove();if(embedded)shell.remove();}};

}
if(typeof window!=='undefined')window.DgcPips={mount:mountPips,mountSetupCards,mountDigestBar,mountHomePips};
if(typeof window!=='undefined'&&typeof acquireVsCodeApi==='function'&&!window.document.getElementById('pips-host')){
  const api=acquireVsCodeApi();
  // Plugins' cards in a Pip's replies (MCP Apps): what one asks goes to the extension host, its answers come back here.
  window.DgcMcpApps?.setup({post:message=>api.postMessage(message),surface:'pip'});
  window.addEventListener('message',event=>{const m=event.data;if(window.DgcMcpApps?.host(m))return;if(m?.type==='event'&&/^mcp_app_/.test(String(m.event?.type||'')))window.DgcMcpApps?.event(m.event);});
  const app=mountPips({root:window.document,postMessage:message=>api.postMessage(message),getState:()=>api.getState?.(),setState:value=>api.setState?.(value),onMessage:listener=>{const handle=event=>listener(event.data);window.addEventListener('message',handle);return()=>window.removeEventListener('message',handle);}});
  window.addEventListener('message',event=>{if(event.data?.type==='pipsNavigate')void app.navigate(event.data.navigation);});
}
