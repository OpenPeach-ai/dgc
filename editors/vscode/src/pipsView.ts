import * as vscode from 'vscode';
import { MIC_MESSAGES, SPEAK_MESSAGES, type Dictation, type DictationOwner, type ReadAloud } from './voice';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import { FILE_ACTS, keptFileAct } from './fileActs';
import { downloadBytes, downloadFile, downloadMade, takeSave } from './download';
import { GitRefs } from './gitRefs';
import { openCommit } from './gitCommitDoc';
import { isAbsolute } from 'path';
import type { Artifacts } from './artifacts';
import { mcpAppsHost } from './mcpApps';
import { handleVideoMessage, VIDEO_MESSAGES } from './videoHost';
import { displayMentions, workspaceFiles } from './mentionsHost';
import { APP_ID, appLogoData } from './pluginLogos';
import { markIcon } from './dock';
import { pipFace, pipTabFace } from './pipTabFace';
import marks from '../media/shared/marks.js';
import { FOLDERS_API, foldersOffered, fullFolder } from './projectFolder';
import { PROJECTS_API, PROJECT_COMMANDS, PROJECT_WORK_COMMAND, patchFileName, pipProjectsRefusal, projectChange, projectWorkBrief, projectWorkRequest } from './pipProjects.js';

/** What a Pip's page uses of the artifacts (artifacts.ts): the person's dashboards, and opening one. */
type PipArtifactsHub = Pick<Artifacts, 'list' | 'open' | 'offers'>;
const ARTIFACT_ID = /^ar_[a-f0-9]{16}$/;

// (The last six: webhooks in, fully local, Pips API 90: a routine's own secret address, and how calls reach this computer.)
/** A goal for a Personal Pip's conversation (pips-15, Pips API 92, dgc/pip_goals.py): set_pip_goal {pip_id, objective,
 *  conversation_id?}, get_pip_goal {pip_id, conversation_id?} and stop_pip_goal {pip_id, goal_id}. An older DGC has none. */
export const GOALS_API = 92;
const GOAL_COMMANDS = ['set_pip_goal', 'get_pip_goal', 'stop_pip_goal'];
export function pipGoalsRefusal(request: any, apiVersion: number): string {
  if (!GOAL_COMMANDS.includes(request?.type)) return '';
  if (apiVersion < GOALS_API) return 'Update DGC to give a Pip a goal.';
  if (request.type === 'set_pip_goal' && (typeof request.objective !== 'string' || !request.objective.trim() || [...request.objective.trim()].length > 4000)) return 'Say what the goal is, in up to 4,000 characters.';
  if (request.type === 'stop_pip_goal' && (typeof request.goal_id !== 'string' || !/^pipgoal_[0-9a-f]{32}$/.test(request.goal_id))) return 'That goal isn’t this Pip’s.';
  return '';
}
/** A Project Pip's owner session (Pips API 89, dgc/pip_owners.py): the one Work chat its reports reach. get_pip_owner
 *  {pip_id}, set_pip_owner {pip_id, session_id (null: no session)} and list_session_pips {session_id} are DGC's;
 *  list_work_session_titles is the editor's own answer (the titles its Work list shows), never a Pip control. */
export const OWNERS_API = 89;
/** The Project Folder dropdown (Pips API 93, dgc/project_folders.py): list_project_folders {} lists the folders with a
 *  Work session or a Project Pip, add_project_folder {folder} makes a picked folder a project, list_pips takes scope
 *  "projects" (every project's Pips) and list_pip_attention takes projects ("all" or one project's workspace id). Why a
 *  request is refused, or '' when it may go: an older DGC is never sent any of them, and a folder is added only when
 *  the editor's own folder picker gave it (Add a folder…) or DGC listed it: never one a page names by itself. */
const FOLDER_COMMANDS = ['list_project_folders', 'add_project_folder'];
/** Give it a folder and Remove its folder (Pips API 110, dgc/pip_folder.py): give_pip_folder {pip_id, folder, dry_run?}
 *  and remove_pip_folder {pip_id, dry_run?}. An older DGC is sent neither, and a folder is given only when the editor's
 *  own picker gave it, DGC listed it, or it is this window's folder: never one a page names by itself. */
const MOVE_COMMANDS = ['give_pip_folder', 'remove_pip_folder'];
export const GIVE_FOLDER_API = 110;
/** A job a chat handed a Pip (Pips API 111, dgc/pip_jobs.py): get_pip_job {job_id} reads one job's card, list_pip_jobs
 *  {pip_id} the jobs a Pip was handed, and start_pip_job / decline_pip_job {pip_id, job_id} are Start and Not now on a
 *  job waiting at Ask me first. An older DGC is sent none of them. */
export const JOB_COMMANDS = ['get_pip_job', 'list_pip_jobs', 'start_pip_job', 'decline_pip_job'];
export const PIP_JOBS_API = 111;
export function pipJobsRefusal(request: any, apiVersion: number): string {
  if (!JOB_COMMANDS.includes(request?.type)) return '';
  if (apiVersion < PIP_JOBS_API) return 'Update DGC to follow a Pip’s job here.';
  const pip = typeof request.pip_id === 'string' && /^pip_[a-f0-9]{32}$/.test(request.pip_id);
  const job = typeof request.job_id === 'string' && /^pipjob_[a-f0-9]{32}$/.test(request.job_id);
  if (request.type === 'get_pip_job') return job ? '' : 'Choose a job.';
  if (request.type === 'list_pip_jobs') return pip ? '' : 'Choose a Pip.';
  return pip && job ? '' : 'Choose a job.';
}
/** Your Browser from the side bar (Pips API 107): the dock's and Home's Browser open it (open_your_browser {url?,
 *  editor_bounds?}), Home's card reads the newest of your own tabs (get_your_browser_recent {}), and its Install button
 *  installs Google Chrome through the system's own password prompt (install_google_chrome {}). Only those fields; a Pip's
 *  own tab opens through its own editor tab, never from here. An older DGC is sent none of them. */
export const YOUR_BROWSER_HOME_COMMANDS = ['open_your_browser', 'get_your_browser_recent', 'install_google_chrome'];
const BOX_KEYS = ['x', 'y', 'width', 'height'];
/** A box the side bar measured: {x, y, width, height} as finite numbers, nothing else. */
const isBox = (b: any) => !!b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).every((key) => BOX_KEYS.includes(key))
  && BOX_KEYS.every((key) => typeof b[key] === 'number' && Number.isFinite(b[key]));
export function yourBrowserHomeRefusal(request: any, apiVersion: number): string {
  if (!YOUR_BROWSER_HOME_COMMANDS.includes(request?.type)) return '';
  if (apiVersion < YOUR_BROWSER_API) return 'Update DGC to use Your Browser.';
  const refused = 'Your Browser can\'t be asked that from here.';
  const keys = Object.keys(request).filter((key) => key !== 'type');
  if (request.type !== 'open_your_browser') return keys.length ? refused : '';
  if (keys.some((key) => key !== 'url' && key !== 'editor_bounds')) return refused;
  if ('url' in request && (typeof request.url !== 'string' || request.url.length > 2000)) return refused;
  if ('editor_bounds' in request) {
    // The editor window's box, and with it the screen's free area (`screen`, the same four numbers) where it knows it.
    const { screen, ...box } = request.editor_bounds || {};
    if (!request.editor_bounds || typeof request.editor_bounds !== 'object' || !isBox(box) || (screen !== undefined && !isBox(screen))) return refused;
  }
  return '';
}
export function projectFoldersRefusal(request: any, apiVersion: number, mayAdd: (folder: string) => boolean): string {
  const own = (key: string) => Object.prototype.hasOwnProperty.call(request || {}, key);
  if (MOVE_COMMANDS.includes(request?.type)) {
    if (apiVersion < GIVE_FOLDER_API) return 'Update DGC to give a Pip a folder.';
    if (!(typeof request.pip_id === 'string' && /^pip_[a-f0-9]{32}$/.test(request.pip_id))) return 'Choose a Pip.';
    if (own('dry_run') && typeof request.dry_run !== 'boolean') return 'Say whether DGC only says what would change.';
    if (request.type === 'give_pip_folder' && !(fullFolder(request.folder) && mayAdd(request.folder))) return 'Choose the folder from the list, or with Add a folder…, first.';
    return '';
  }
  const scoped = request?.type === 'list_pips' && own('scope') || request?.type === 'list_pip_attention' && own('projects');
  if (!FOLDER_COMMANDS.includes(request?.type) && !scoped) return '';
  if (apiVersion < FOLDERS_API) return 'Update DGC to choose a project folder.';
  // One Pips (Pips API 94): scope "all" is every Pip in one list, Personal and every project's.
  if (request.type === 'list_pips' && request.scope === 'all') return apiVersion >= ONE_PIPS_API ? '' : 'Update DGC to see every Pip in one list.';
  if (request.type === 'list_pips' && request.scope !== 'projects') return 'List one project’s Pips, or every project’s.';
  if (request.type === 'list_pip_attention' && request.projects !== 'all' && !(typeof request.projects === 'string' && /^ws_[a-f0-9]{32}$/.test(request.projects))) return 'Choose All projects or one project folder.';
  if (request.type === 'add_project_folder' && !(fullFolder(request.folder) && mayAdd(request.folder))) return 'Choose the folder with Add a folder… first.';
  return '';
}
export const ONE_PIPS_API = 94;
/** Pips API 96: no session owns a Pip; list_related_pips says which Pips a session is related to (its agent map). */
export const RELATED_API = 96;
export interface RelatedPip { id: string; name: string; pip_type: string; why: Array<'asked' | 'set_up' | 'folder'>; running: boolean; needs_you: number }
/** What a Pip found and its fix, in its own chat (the Pips flow design of 14 Nov; Pips API 96; src/pipFlow.js):
 *  list_pip_fixes {pip_id} reads its fixes and what only the user can do, decide_pip_fix {pip_id, fix_id,
 *  expected_digest, allow} is the Allow card's answer, start_pip_work_helper {pip_id, fix_id} starts a sub-agent with
 *  Work tools on the real folder (from Pips API 109: WORK_AGENTS_API), answer_pip_waiting {pip_id, waiting_id, answer} answers what only the user can do, and
 *  commit_pip_project_change {pip_id, change_id} commits the files a fix put in the folder. Why a request is refused,
 *  or '' when it may go: an older DGC is never sent any of them, and each must name its Pip and what it answers. */
const FLOW_COMMANDS = ['list_pip_fixes', 'decide_pip_fix', 'start_pip_work_helper', 'answer_pip_waiting', 'commit_pip_project_change'];
export const FLOW_API = 96;
export function pipFlowRefusal(request: any, apiVersion: number): string {
  if (!FLOW_COMMANDS.includes(request?.type)) return '';
  if (apiVersion < FLOW_API) return 'Update DGC to see what a Pip found and fixed in its chat.';
  const id = (v: unknown, re: RegExp) => typeof v === 'string' && re.test(v);
  if (!id(request.pip_id, /^pip_[a-f0-9]{32}$/)) return 'Choose a Pip first.';
  if (request.type === 'decide_pip_fix' && !(id(request.fix_id, /^pipfix_[a-f0-9]{32}$/) && typeof request.expected_digest === 'string' && request.expected_digest.length <= 128 && typeof request.allow === 'boolean')) return 'Answer the fix its card shows: Allow, or Not now.';
  if (request.type === 'start_pip_work_helper' && apiVersion < WORK_AGENTS_API) return 'Update DGC to start a sub-agent with Work tools.';
  if (request.type === 'start_pip_work_helper' && !id(request.fix_id, /^pipfix_[a-f0-9]{32}$/)) return 'Choose the fix the sub-agent is for.';
  if (request.type === 'answer_pip_waiting' && !(id(request.waiting_id, /^pipwait_[a-f0-9]{32}$/) && ['done', 'later', 'not_a_problem', 'undo'].includes(request.answer))) return 'Choose I’ve done it, Remind me later or Not a problem.';
  if (request.type === 'commit_pip_project_change' && !id(request.change_id, /^pchange_[0-9a-f]{32}$/)) return 'Choose the change to commit.';
  return '';
}
/** A Pip's sub-agents in its chat (Pips API 97, dgc/pip_agents.py; src/pipChat.js): list_pip_agents {pip_id} reads
 *  them for the pill and the agent map, stop_pip_agent {pip_id, agent_id} is Stop, and retry_pip_fix {pip_id, fix_id,
 *  again} answers the Pip after its last try (Try again, or Leave it). Why a request is refused, or '' when it may go.
 *  From Pips API 104 set_pip_agents also takes what they run on (its picker's Sub-agents tab): model_choice ("This
 *  Pip's model" is mode default; a model on DGC's own connection, or a saved provider's; never a subscription app or
 *  DGC Router), thinking, context_size and fallback ({provider, model}, model "" for none). */
const AGENT_COMMANDS = ['list_pip_agents', 'stop_pip_agent', 'set_pip_agents', 'retry_pip_fix', 'undo_pip_agent_job'];
export const AGENTS_API = 97;
export const AGENTS_OWN_API = 104;
/** A Pip's sub-agent with Work tools (Pips API 109; dgc/pip_work_agents.py):
 *  start_pip_work_helper starts one on the real folder (the user's press is the yes at every level), and
 *  undo_pip_agent_job {pip_id, job_id} puts back what it changed there. An older DGC is sent neither. */
export const WORK_AGENTS_API = 109;
const OWN_FIELDS = ['model_choice', 'thinking', 'context_size', 'fallback'];
const OWN_PROVIDER = /^provider_[a-f0-9]{32}$/;
const ownModelId = (v: unknown) => typeof v === 'string' && v.length >= 1 && v.length <= 256;
/** A model choice for a Pip's sub-agents, or why it isn't one. */
function ownChoiceProblem(c: any): string {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'Choose a model for its sub-agents.';
  if (c.mode === 'subscription') return 'It runs its own tools, so it can’t run DGC’s sub-agents.';
  if (c.mode === 'router') return 'DGC Router can’t run a Pip’s sub-agents: a Pip’s run holds one of its systems at most.';
  const keys = Object.keys(c).sort().join();
  if (c.mode === 'default' && keys === 'mode') return '';
  if (c.mode === 'model' && keys === 'mode,model' && ownModelId(c.model)) return '';
  if (c.mode === 'provider' && keys === 'mode,model,provider' && OWN_PROVIDER.test(String(c.provider)) && ownModelId(c.model)) return '';
  return 'Choose a model for its sub-agents.';
}
function ownAgentsProblem(request: any): string {
  if ('model_choice' in request) { const problem = ownChoiceProblem(request.model_choice); if (problem) return problem; }
  if ('thinking' in request && !['', 'off', 'low', 'medium', 'high', 'xhigh'].includes(request.thinking)) return 'Their thinking is Same, Off, Low, Medium, High or Extra high.';
  if ('context_size' in request && !(Number.isSafeInteger(request.context_size) && (request.context_size === 0 || (request.context_size >= 2048 && request.context_size <= 16777216)))) return 'Their context window is the same as the Pip’s, or 2K to 16,384K.';
  if ('fallback' in request) {
    const f = request.fallback;
    if (!f || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).some((k) => k !== 'provider' && k !== 'model') || typeof f.model !== 'string' || f.model.length > 256
      || typeof f.provider !== 'string' || (f.provider !== '' && !OWN_PROVIDER.test(f.provider))) return 'Their fallback is a model DGC runs itself, or none.';
  }
  return '';
}
export function pipAgentsRefusal(request: any, apiVersion: number): string {
  if (!AGENT_COMMANDS.includes(request?.type)) return '';
  if (apiVersion < AGENTS_API) return 'Update DGC to see a Pip’s sub-agents in its chat.';
  const id = (v: unknown, re: RegExp) => typeof v === 'string' && re.test(v);
  if (!id(request.pip_id, /^pip_[a-f0-9]{32}$/)) return 'Choose a Pip first.';
  if (request.type === 'stop_pip_agent' && !id(request.agent_id, /^pipagent_[a-f0-9]{32}$/)) return 'Choose the sub-agent to stop.';
  // Ultra on the Pip's thinking slider: how many of its sub-agents run at once (1, or 4 for Ultra; DGC holds the most).
  // From 104, what they run on too; an older DGC is sent only `slots`.
  if (request.type === 'set_pip_agents') {
    const own = OWN_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(request, key));
    if (own.length && apiVersion < AGENTS_OWN_API) return 'Update DGC to choose a model for a Pip’s sub-agents.';
    if ((Object.prototype.hasOwnProperty.call(request, 'slots') || !own.length) && !(Number.isSafeInteger(request.slots) && request.slots >= 1 && request.slots <= 64)) return 'A Pip runs 1 to 4 sub-agents at once.';
    const problem = ownAgentsProblem(request);
    if (problem) return problem;
  }
  if (request.type === 'retry_pip_fix' && !(id(request.fix_id, /^pipfix_[a-f0-9]{32}$/) && typeof request.again === 'boolean')) return 'Answer the Pip: Try again, or Leave it.';
  if (request.type === 'undo_pip_agent_job') {
    if (apiVersion < WORK_AGENTS_API) return 'Update DGC to undo what a sub-agent with Work tools changed.';
    if (!id(request.job_id, /^pipagent_[a-f0-9]{32}$/)) return 'Choose the sub-agent whose change to undo.';
  }
  return '';
}
const OWNER_COMMANDS = ['get_pip_owner', 'set_pip_owner', 'list_session_pips'];
export const WORK_SESSIONS_COMMAND = 'list_work_session_titles';
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
export function pipOwnersRefusal(request: any, apiVersion: number): string {
  if (!OWNER_COMMANDS.includes(request?.type) && request?.type !== WORK_SESSIONS_COMMAND) return '';
  if (apiVersion < OWNERS_API) return 'Update DGC to choose a Project Pip’s owner session.';
  if (request.type === 'set_pip_owner' && request.session_id !== null && (typeof request.session_id !== 'string' || !SESSION_ID.test(request.session_id))) return 'Choose one of this project’s sessions.';
  if (request.type === 'list_session_pips' && (typeof request.session_id !== 'string' || !SESSION_ID.test(request.session_id))) return 'Choose a session.';
  return '';
}
/** A Work session as the owner picker and the "move its Pips" dialog are told of it: `when` is DGC's own
 *  "YYYY-MM-DD HH:MM" for when it is from (list_sessions' `when`), so same-titled sessions can be told apart. */
export interface WorkSessionTitle { id: string; title: string; empty?: true; when?: string }
const SESSION_WHEN = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/;
/** The Work list's titles, checked: only real session ids, each once, a title cut at 200, 500 at most. */
export function workSessionTitles(list: unknown): WorkSessionTitle[] {
  const seen = new Set<string>(), out: WorkSessionTitle[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item.id !== 'string' || !SESSION_ID.test(item.id) || seen.has(item.id) || typeof item.title !== 'string' || out.length >= 500) continue;
    seen.add(item.id);
    // A session with nothing in it (12 Nov: the picker read "(empty)", the backend's preview of one): said to be empty,
    // never offered, and that preview is never its title.
    const title = item.title.replace(/\s+/g, ' ').trim().slice(0, 200);
    // (When it is from, 12 Nov night: only DGC's own date and time, cut there; anything else is left out.)
    out.push({ id: item.id, title: title === '(empty)' ? '' : title, ...(item.empty === true ? { empty: true as const } : {}),
      ...(typeof item.when === 'string' && SESSION_WHEN.test(item.when) ? { when: item.when.slice(0, 16) } : {}) });
  }
  return out;
}
/** A Project Pip a session owns, as list_session_pips lists it. */
export interface OwnedPip { id: string; name: string; pip_type: string; status: string }
const commands = new Set([...AGENT_COMMANDS,'set_pip_pay_limits','set_pip_knows_you','list_pip_sent','get_pip_import_prompt','import_pip_source','get_pip_skills','set_pip_skill','get_pip_apps','set_pip_app','add_pip_app_account','list_pip_conversations','create_pip_conversation','rename_pip_conversation','archive_pip_conversation','add_pip_computer','list_pip_keys','save_pip_key','decline_pip_key','remove_pip_key','list_pip_flows','get_pip_flow','create_pip_flow','set_pip_flow','get_pip_artifacts','set_pip_artifacts','list_pip_run_fixes','list_pip_templates','decide_pip_template_change','list_app_events','list_apps','accept_app_update','list_pip_borrows','allow_pip_borrow','decline_pip_borrow','stop_pip_borrow','get_pip_level','set_pip_level','get_pip_working_notes','set_pip_working_notes','list_pip_daily_log','list_pip_logins','save_pip_login','remove_pip_login','grant_pip_login','fill_pip_code','get_pip_computer_apps','set_pip_computer_apps','get_pip_eyes','set_pip_eyes','list_pip_run_posts','list_pip_unread','mark_pip_read','check_pip_source','get_pip_run_source','mark_pip_news_seen','set_pip_chat_options','set_plugin_permission','list_pip_sites','set_pip_careful','forget_pip_site','list_pip_notes','add_pip_note','forget_pip_note','list_pip_attention','get_pips_limit','set_pips_limit','list_pip_reply_stats','get_pip_chat_context','list_pip_plugins','allow_pip_plugin','decline_pip_plugin','list_pip_plugin_uses','list_pip_routines','add_pip_routine','update_pip_routine','delete_pip_routine','decide_pip_routine','set_pip_profile','list_pip_shared','get_pip_computers','update_pip_computers','reset_pip_computer','list_pip_apps','finish_pip_computer_check','list_pip_app_links','start_pip_app_link','check_pip_app_link','decline_pip_app_link','disconnect_pip_app_link','get_pip_computer_desktop','list_pip_computer_files','read_pip_computer_file','add_pip_computer_file','remove_pip_computer_file','run_pip_computer_command','list_pip_computer_terminal','get_pip_message_image','library_pip_message_image','introduce_pip','always_allow_pip_computer_action','get_pip_computer','list_pip_computer_actions','decide_pip_computer_action','get_pip_computer_frame','list_pip_computer_frames','stop_pip_computer','open_pip_computer','use_pip_computer_view','always_allow_pip_app_action','list_pip_action_grants','revoke_pip_action_grant','set_pip_feedback','list_pip_feedback','export_pip','get_pip_usage','get_pips_backup','set_pips_backup','get_pip_backup','set_pip_backup','undo_pip_change','get_pips_payments','set_pips_payments','set_pip_paying','get_pips_desktop_notifications','set_pips_desktop_notifications','get_pips_keep_running','set_pips_keep_running','list_pip_starters','propose_starter_pip','get_pip_digest','mark_pip_digest_seen','get_pip_notify_settings','set_pip_notify_settings','get_pip_outcomes','get_pip_connector_draft','list_pip_connector_drafts','prepare_pip_connector_draft','dismiss_pip_connector_draft','inspect_pip_connector_actions','propose_pip_connector_action','get_pip_calendar_draft','list_pip_calendar_drafts','prepare_pip_calendar_draft','dismiss_pip_calendar_draft','inspect_pip_calendar_connection','propose_pip_calendar_action','get_pip_message_draft','list_pip_message_drafts','prepare_pip_message_draft','dismiss_pip_message_draft','inspect_pip_send_connection', 'propose_pip_app_action', 'get_pip_app_action', 'list_pip_app_actions', 'accept_pip_app_action', 'reject_pip_app_action', 'propose_pip_personal_handoff', 'list_pip_accounts', 'list_pip_connections', 'inspect_pip_connection', 'notify_pip_setup', 'revise_pip_setup', 'list_pip_setups', 'get_pip_setup', 'accept_pip_setup', 'reject_pip_setup', 'get_pip_statement_anchor', 'record_pip_statement', 'revoke_pip_statement', 'list_pip_statements', 'list_workspace_execution_receipts', 'get_workspace_execution_receipt', 'record_workspace_execution_context', 'archive_pip', 'restore_pip', 'delete_archived_pip', 'get_pip_exception_source', 'record_pip_exception', 'revoke_pip_exception', 'list_pip_memories', 'list_pip_notifications', 'mark_pip_notification_read', 'list_workspace_sessions', 'inspect_workspace_session_outcome', 'propose_workspace_session_outcome', 'get_workspace_session_outcome', 'list_workspace_session_outcomes', 'accept_workspace_session_outcome', 'reject_workspace_session_outcome', 'list_pip_types', 'list_pip_models', 'list_pip_messages', 'send_pip_message', 'answer_pip_questions', 'list_workspaces', 'list_pips', 'create_pip', 'get_pip', 'get_pip_proposal', 'list_pip_adaptations', 'run_pip', 'list_pip_runs', 'get_pip_run', 'list_pip_run_activity', 'pause_pip', 'resume_pip', 'cancel_pip_run', 'propose_pip_update', 'accept_pip_update', 'reject_pip_update', 'list_pip_versions', 'list_pip_approvals', 'list_pip_checkpoints', 'review_pip_finding', 'review_pip_execution', 'get_pip_execution', 'propose_pip_handoff', 'propose_pip_artifact_handoff', 'get_pip_handoff', 'list_pip_handoffs', 'accept_pip_handoff', 'reject_pip_handoff', 'get_pip_runner', 'stop_pips', 'get_workspace_context', 'record_workspace_context', 'archive_workspace_context', 'accept_pip_finding', 'accept_pip_execution_context', 'rename_pip_computer', 'set_pip_computer_screen', 'get_pip_webhook', 'replace_pip_webhook_address', 'set_pip_webhook_signing', 'send_pip_webhook_test', 'get_webhook_reach', 'set_webhook_reach', ...OWNER_COMMANDS, ...GOAL_COMMANDS, ...PROJECT_COMMANDS, ...FOLDER_COMMANDS, ...MOVE_COMMANDS, ...FLOW_COMMANDS, ...JOB_COMMANDS, ...YOUR_BROWSER_HOME_COMMANDS]);
/** Images sent with a Pip message, as data URIs: 2 MiB of image, base64, plus headers. */
const MAX_IMAGE_URI_CHARS = 2_800_000;
/** Pips API 52: photos and files go the Work chat's way. The host writes them into the backend's spool
 *  (ready.capabilities.image_spool_dir) and sends their names, so the 4 MiB command frame no longer caps
 *  them: 8 MiB a photo and 32 MiB of photos a message (no four-photo cap; 64 is the request's own bound),
 *  and the Work chat's document limits for files (16 MiB a document, 1 MiB a text or code file, 32 MiB). */
const MiB = 1024 * 1024;
const SPOOL_PHOTO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/heic': 'heic', 'image/heif': 'heif' };
const MAX_SPOOLED_PHOTOS = 64, MAX_TEXT_FILE_BYTES = MiB;
/** What one message may carry: from Pips API 79 (Limits for everyone, 10 Nov) 20 MB a photo, 50 files, 100 MB a
 *  document and 200 MB in all; an older runtime keeps API 52's, so it is never sent what it would refuse. */
type SpoolLimits = { photo: number; photos: number; files: number; document: number; filesBytes: number; message: number };
const OLD_LIMITS: SpoolLimits = { photo: 8 * MiB, photos: 32 * MiB, files: 16, document: 16 * MiB, filesBytes: 32 * MiB, message: Infinity };
const RAISED_LIMITS: SpoolLimits = { photo: 20 * MiB, photos: 200 * MiB, files: 50, document: 100 * MiB, filesBytes: 200 * MiB, message: 200 * MiB };
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.rtf']);
const mb = (n: number) => `${Math.round(n / MiB)} MB`;
const photoLimits = (l: SpoolLimits) => `Send photos of up to ${mb(l.photo)} each, ${mb(l.photos)} in all.`;
const fileLimits = (l: SpoolLimits) => `Send up to ${l.files} files: documents up to ${mb(l.document)}, text and code up to 1 MB, ${mb(l.filesBytes)} in all.`;
const DATA_URI = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i;
const decodedBytes = (b64: string) => Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
/** A Pip chat's kept photo: <state>/chat_images/<pip_id>/<sha256>.<ext>, as the backend names it. */
const KEPT_PHOTO = /^[0-9a-f]{64}\.(png|jpg|gif|webp|bmp)$/;
/** A file in a Pip's chat is kept under its digest, with no ending (dgc/pip_chat.py file_directory). */
const KEPT_FILE = /^[0-9a-f]{64}$/;
/** What a page may be handed the bytes of, to play: a video or a sound. Anything else opens or saves. */
const PLAYABLE = /^(?:video|audio)\/[A-Za-z0-9.+-]{1,60}$/;
/** The most a Pip sends as one file (dgc/pip_chat_sends.py MAX_FILE_BYTES); a larger answer is not a kept file. */
const KEPT_FILE_BYTES = 200 * MiB;
const FILES_API = 101;
const KEPT_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
const attr = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** A question card under a Pip's reply, as Work has it (Pips API 106): its answers go as the user's next message, or it
 *  closes with nothing sent. Why answer_pip_questions is refused, or '' when it may go. */
export const QUESTIONS_API = 106;
export function questionsRefusal(request: any, apiVersion: number): string {
  if (request?.type !== 'answer_pip_questions') return '';
  if (apiVersion < QUESTIONS_API) return 'Update DGC to answer a Pip’s questions on their card.';
  if (typeof request.message_id !== 'string' || !/^message_[0-9a-f]{32}$/.test(request.message_id)) return 'Answer the questions of one of this Pip’s replies.';
  const answering = Object.prototype.hasOwnProperty.call(request, 'answers');
  if ((request.dismissed === true) === answering || (Object.prototype.hasOwnProperty.call(request, 'dismissed') && request.dismissed !== true)) return 'Send your answers, or close the card.';
  if (answering && (!request.answers || typeof request.answers !== 'object' || Array.isArray(request.answers) || !Object.keys(request.answers).length
      || Object.keys(request.answers).length > 4 || typeof request.idempotency_key !== 'string')) return 'Answer the card’s own questions.';
  return '';
}
/** Several conversations per Pip, and several computers (Pips API 79). Why a request is refused, or '' when it may go:
 *  an older DGC knows one chat a Pip, so it is never asked for a conversation, sent one's id, or asked for a computer. */
const CONVERSATION_COMMANDS = ['list_pip_conversations', 'create_pip_conversation', 'rename_pip_conversation', 'archive_pip_conversation'];
const CONVERSATION_ID = /^conv_[0-9a-f]{32}$/;
export function conversationsRefusal(request: any, apiVersion: number): string {
  const own = (key: string) => Object.prototype.hasOwnProperty.call(request || {}, key);
  const named = own('conversation_id') || request?.type === 'update_pip_routine' && Object.prototype.hasOwnProperty.call(request.changes || {}, 'conversation_id');
  if (CONVERSATION_COMMANDS.includes(request?.type) || named) {
    if (apiVersion < 79) return 'Update DGC to have several conversations with a Pip.';
    const id = own('conversation_id') ? request.conversation_id : request.changes?.conversation_id;
    const moved = request.type === 'update_pip_routine' && id === null;      // a routine back to the first conversation
    if (named && !moved && !(typeof id === 'string' && CONVERSATION_ID.test(id))) return 'Choose one of this Pip’s conversations.';
  }
  if (request?.type === 'add_pip_computer' && apiVersion < 79) return 'Update DGC to give a Pip another computer.';
  return '';
}
/** pips-17d: each of a Pip's computers has a name (Pips API 86). rename_pip_computer {pip_id, number, name} names one ("" gives
 *  back its first name), and open_pip_computer and use_pip_computer_view may say which computer by `number`. Why a request
 *  is refused, or '' when it may go: an older DGC is never sent a number or a name; a number is a whole one from 1; a name
 *  is what DGC itself takes (dgc/pip_computer.py), already tidied by the page. */
const COMPUTER_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_ .'&()-]{0,29}$/u;
export const computerNumber = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= 1000;
export function computerNamesRefusal(request: any, apiVersion: number): string {
  const numbered = Object.prototype.hasOwnProperty.call(request || {}, 'number');
  if (request?.type === 'rename_pip_computer') {
    if (apiVersion < 86) return 'Update DGC to name a Pip’s computers.';
    if (!computerNumber(request.number)) return 'Choose one of this Pip’s computers.';
    if (typeof request.name !== 'string' || request.name && !COMPUTER_NAME.test(request.name)) return 'A computer’s name is up to 30 letters, digits, spaces and . \' & ( ) -, starting with a letter or digit.';
  } else if (numbered && ['open_pip_computer', 'use_pip_computer_view'].includes(request?.type)) {
    if (apiVersion < 86) return 'Update DGC to choose which of a Pip’s computers to open.';
    if (!computerNumber(request.number)) return 'Choose one of this Pip’s computers.';
  }
  return '';
}
/** pips-09: "Apps it can use" on a Pip's page (Pips API 88). get_pip_apps {pip_id} lists its apps, set_pip_app {pip_id,
 *  app, on} switches one, add_pip_app_account {pip_id, app} asks for one more address of an app it has. Why a request is
 *  refused, or '' when it may go: an older DGC is never sent one; an app is named as DGC names it; on is true or false. */
const PIP_APP = /^[a-z0-9][a-z0-9_-]{1,39}$/;
export function pipAppsRefusal(request: any, apiVersion: number): string {
  if (!['get_pip_apps', 'set_pip_app', 'add_pip_app_account'].includes(request?.type)) return '';
  if (apiVersion < 88) return 'Update DGC to choose the apps a Pip can use.';
  if (request.type !== 'get_pip_apps' && (typeof request.app !== 'string' || !PIP_APP.test(request.app))) return 'Choose one of the apps on this Pip’s page.';
  if (request.type === 'set_pip_app' && typeof request.on !== 'boolean') return 'Switch an app on or off.';
  return '';
}
/** pips-12: a switch per skill on a Pip's page (Pips API 88). get_pip_skills {pip_id} lists its skills, set_pip_skill
 *  {pip_id, skill, on} switches one. Why a request is refused, or '' when it may go: an older DGC is never sent one; a
 *  skill is named as DGC names it; on is true or false. (The Personal list's folders, set_pip_profile's changes.group,
 *  were dropped before release, 0.52.) */
const PIP_SKILL = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export function pipTeamsRefusal(request: any, apiVersion: number): string {
  if (['get_pip_skills', 'set_pip_skill'].includes(request?.type)) {
    if (apiVersion < 88) return 'Update DGC to choose the skills a Pip can use.';
    if (request.type === 'set_pip_skill' && (typeof request.skill !== 'string' || !PIP_SKILL.test(request.skill))) return 'Choose one of the skills on this Pip’s page.';
    if (request.type === 'set_pip_skill' && typeof request.on !== 'boolean') return 'Switch a skill on or off.';
    return '';
  }
  return '';
}
/** pips-18: import a bot (Pips API 88). get_pip_import_prompt {} gives the prompt to paste into a Grok bot;
 *  import_pip_source {source: "github", url} names a team file or a Pip's file on GitHub for DGC to fetch, and
 *  import_pip_source {source: "grok", text} carries what the bot wrote. Why a request is refused, or '' when it may go:
 *  an older DGC is never sent one; a source is github or grok; a link is https, at one of GitHub's hosts, up to 2,048
 *  characters; a reply is up to 64 KiB; and a request carries nothing else. */
const IMPORT_HOSTS = ['github.com', 'raw.githubusercontent.com', 'gist.githubusercontent.com'];
export const IMPORT_REPLY_BYTES = 64 * 1024;
export function pipImportsRefusal(request: any, apiVersion: number): string {
  if (!['get_pip_import_prompt', 'import_pip_source'].includes(request?.type)) return '';
  if (apiVersion < 88) return 'Update DGC to import a bot from GitHub or Grok.';
  const keys = Object.keys(request), only = (...allowed: string[]) => keys.length === allowed.length && allowed.every(key => keys.includes(key));
  if (request.type === 'get_pip_import_prompt') return only('type') ? '' : 'Ask for the Grok prompt alone.';
  if (request.source === 'github') {
    const link = request.url;
    if (!only('type', 'source', 'url') || typeof link !== 'string' || !link || link.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(link)) return 'Paste an https link to a file on GitHub.';
    let url: URL | undefined;
    try { url = new URL(link); } catch { /* refused below */ }
    if (!url || !/^https:\/\//i.test(link) || url.protocol !== 'https:' || url.username || url.password || url.port || !IMPORT_HOSTS.includes(url.hostname.toLowerCase())) return 'Paste an https link to a file on GitHub.';
    return '';
  }
  if (request.source === 'grok') {
    if (!only('type', 'source', 'text') || typeof request.text !== 'string' || !request.text.trim()) return 'Paste what your Grok bot wrote.';
    if (Buffer.byteLength(request.text, 'utf8') > IMPORT_REPLY_BYTES) return 'What a Grok bot wrote is 64 KiB at most.';
    return '';
  }
  return 'Import from a GitHub link or from a Grok bot.';
}
/** pips-12: a whole team as one file (Pips API 88, format dgc-team): up to 20 Pips, 256 KiB at most. */
const TEAM_FILE_BYTES = 256 * 1024;
const TEAM_PIPS = 20;
/** The name a team's file is offered under in the save dialog: the team's name in plain letters, then .dgc-team.json. */
export function teamFileName(name: unknown): string {
  const base = String(typeof name === 'string' ? name : '').normalize('NFKD').replace(/[^A-Za-z0-9 _-]+/g, ' ').trim().replace(/\s+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '');
  return (base || 'my-team').toLowerCase() + '.dgc-team.json';
}
/** pc-fills-tab: a Pip's computers have a screen size (Pips API 86). set_pip_computer_screen {pip_id, size} chooses one
 *  of the sizes DGC offers ("1440x900"), taken as its screen next starts. Why a request is refused, or '' when it may go. */
export function computerScreenRefusal(request: any, apiVersion: number): string {
  if (request?.type !== 'set_pip_computer_screen') return '';
  if (apiVersion < 86) return 'Update DGC to change the size of a Pip’s screen.';
  if (typeof request.size !== 'string' || !/^\d{3,5}x\d{3,5}$/.test(request.size)) return 'Choose one of the screen sizes on offer.';
  return '';
}
/** What a computer tab may put on this computer's clipboard: text copied on the Pip's computer, at most 1 MB. */
const COPY_BYTES = 1_000_000;
/** The names in a DGC reply ([{number, name, ...}]), kept for a tab's title: null when it isn't a list of them. */
function computerNameRows(value: unknown): { number: number; name: string }[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 1000) return null;
  const rows: { number: number; name: string }[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || !computerNumber(row.number) || typeof row.name !== 'string' || !COMPUTER_NAME.test(row.name) && !/^Computer \d{1,4}$/.test(row.name)) return null;
    rows.push({ number: row.number, name: row.name });
  }
  return rows;
}
/** pips-10: allow_pip_plugin may carry `keys` {variable name: text} from Pips API 81 on (a plugin's key, pasted on its
 *  card). Why a request is refused, or '' when it may go: an older DGC is never sent a key, and a key is text. It goes
 *  to DGC's own store for a plugin's key and nowhere else: never kept here, never logged. */
export function keysRefusal(request: any, apiVersion: number): string {
  if (request?.type !== 'allow_pip_plugin' || !Object.prototype.hasOwnProperty.call(request, 'keys')) return '';
  if (apiVersion < 81) return 'Update DGC to give a Pip’s plugin its key.';
  const keys = request.keys, names = keys && typeof keys === 'object' && !Array.isArray(keys) ? Object.keys(keys) : null;
  if (!names || !names.length || names.length > 8 || names.some(name => !/^[A-Za-z0-9_.-]{1,128}$/.test(name)
    || typeof keys[name] !== 'string' || !keys[name].trim() || keys[name].length > 4096)) return 'Paste the key first.';
  return '';
}

/** pips-10 (Pips API 82): a Personal Pip's own API keys. list_pip_keys, save_pip_key {pip_id, key_id, value},
 *  decline_pip_key and remove_pip_key {pip_id, key_id}. Why a request is refused, or '' when it may go: an older DGC is
 *  never sent one, and a request carries exactly its own fields (a key only on save, as one line of text). The key goes
 *  to DGC's own store and nowhere else: never kept here, never logged, and never in what this says.
 *  From Pips API 85 save_pip_key may also carry `terminal` (true or false: also let the Pip's Terminal use the key).
 *  An older DGC is never sent it. */
const PIP_KEY_COMMANDS: Record<string, string[]> = { list_pip_keys: ['pip_id'], save_pip_key: ['pip_id', 'key_id', 'value'],
  decline_pip_key: ['pip_id', 'key_id'], remove_pip_key: ['pip_id', 'key_id'] };
export function pipKeyRefusal(request: any, apiVersion: number): string {
  const fields = typeof request?.type === 'string' && Object.prototype.hasOwnProperty.call(PIP_KEY_COMMANDS, request.type) ? PIP_KEY_COMMANDS[request.type] : null;
  if (!fields) return '';
  if (apiVersion < 82) return 'Update DGC to give a Pip its own keys.';
  const terminal = request.type === 'save_pip_key' && Object.prototype.hasOwnProperty.call(request, 'terminal');
  if (terminal && apiVersion < 85) return 'Update DGC to let a Pip’s Terminal use a key.';
  if (terminal && typeof request.terminal !== 'boolean') return 'Choose a key on the Pip’s card or its page.';
  if (Object.keys(request).some(key => key !== 'type' && !fields.includes(key) && !(terminal && key === 'terminal')) || typeof request.pip_id !== 'string' || !/^pip_[A-Za-z0-9]{1,64}$/.test(request.pip_id)
    || fields.includes('key_id') && (typeof request.key_id !== 'string' || !/^pipkey_[a-f0-9]{32}$/.test(request.key_id))) return 'Choose a key on the Pip’s card or its page.';
  if (request.type !== 'save_pip_key') return '';
  const value = request.value;
  if (typeof value !== 'string' || !value.trim()) return 'Paste the key to save it.';
  if (value.trim().length > 16384 || /[\x00-\x1f\x7f]/.test(value.trim())) return 'That doesn’t look like one key: paste it again, on one line.';
  return '';
}

/** What the page shows until its script draws: the loading mark the script itself draws first (src/pipsClient.js
 *  loadingMark, the same paths), so nothing changes in sight when it takes over. It held the words "Connecting to
 *  local DGC…", which flashed before the mark on every open (0.51 check). */
const PIPS_BOOT_MARK = '<div class="pips-loading" role="status" aria-label="Loading Pips"><svg viewBox="0 0 90 90" fill="currentColor" aria-hidden="true"><path d="M32 24 L20 30 L13 72 L25 66 Z"/><path d="M54 18 L42 24 L35 72 L47 66 Z"/><path d="M76 24 L64 30 L57 66 L69 60 Z"/></svg></div>';

/** What a Pips page is told as it is written: `favicons`, dgc.linkFavicons as it stood (left out: off); `chat`, the Pip
 *  conversation this page is the editor tab of ("Open in editor"), '' for the Pip's first. */
export type PipsPage = { favicons?: boolean; chat?: { pip: string; conversation: string } };
export function pipsDocument(scriptUri = '', styleUri = '', cspSource = '', markdownUri = '', cardsUri = '', cardsStyleUri = '', videoUri = '', codiconUri = '', page: PipsPage = {}): string {
  // img-src: `https:` is what lets a favicon load beside a link (a reply's, and one the user sent), the same allowance
  // Work's page makes, and only while dgc.linkFavicons is on: off, the policy itself keeps any icon from leaving for
  // one, whatever the page draws. It is not what keeps model output from phoning home: the Markdown renderer never
  // emits an <img> for model content (model-images-never-render.test.mjs), and a favicon asks about a link's ORIGIN
  // only (src/markdown.ts, faviconUrl). The page reads the same setting from its body (data-link-favicons).
  const favicons = page?.favicons === true;
  const chat = page?.chat && /^pip_[A-Za-z0-9]{1,64}$/.test(page.chat.pip) && /^(?:conv_[0-9a-f]{32})?$/.test(page.chat.conversation) ? page.chat : undefined;
  const says = ` data-link-favicons="${favicons ? 'on' : 'off'}"${chat ? ` data-pip-chat="${attr(chat.pip)}" data-pip-conversation="${attr(chat.conversation)}"` : ''}`;
  // frame-src: only a plugin's card (MCP Apps), at the loopback address DGC's backend serves it from.
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data:${favicons ? ' https:' : ''}; style-src ${attr(cspSource)} 'unsafe-inline'; script-src ${attr(cspSource)};${codiconUri ? ` font-src ${attr(cspSource)};` : ''} media-src blob:;${cardsUri ? ' frame-src http://127.0.0.1:* http://localhost:*;' : ''}">${codiconUri ? `<link rel="stylesheet" href="${attr(codiconUri)}">` : ''}<link rel="stylesheet" href="${attr(styleUri)}">${cardsStyleUri ? `<link rel="stylesheet" href="${attr(cardsStyleUri)}">` : ''}<title>DGC Pips</title></head><body${says}><main id="app">${PIPS_BOOT_MARK}</main><div id="review-root"></div>${cardsUri ? `<script src="${attr(cardsUri)}"></script>` : ''}${videoUri ? `<script src="${attr(videoUri)}"></script>` : ''}${markdownUri ? `<script src="${attr(markdownUri)}"></script>` : ''}<script src="${attr(scriptUri)}"></script></body></html>`;
}

/** A Pip's computer in an editor tab: its Browser, Files and Terminal. */
export function computerDocument(scriptUri = '', styleUri = '', cspSource = '', title = 'Computer'): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data:; style-src ${attr(cspSource)} 'unsafe-inline'; script-src ${attr(cspSource)};"><link rel="stylesheet" href="${attr(styleUri)}"><title>${attr(title)}</title></head><body><main id="app"><p role="status">Connecting to local DGC…</p></main><script type="module" src="${attr(scriptUri)}"></script></body></html>`;
}
/** A Pip's tab in Your Browser, streamed into an editor tab (Pips API 107; his call, 17 Nov: a VS Code tab beside the
 *  chat shows a Pip's tab live, with DGC's own address bar). Its page may ask for its own Pip's lane and nothing else: a
 *  frame, the person's own hand in it, and bringing that tab forward in the window. Never the person's own tabs. */
export const YOUR_BROWSER_API = 107;
const YOUR_BROWSER_OPS = new Set(['frame', 'click', 'type', 'key', 'scroll', 'go', 'back', 'forward', 'reload', 'close']);
const YOUR_BROWSER_VIEW_FIELDS = new Set(['type', 'pip_id', 'op', 'x', 'y', 'text', 'key', 'dy', 'url']);
export function yourBrowserTabRefusal(request: any, pipId: string): string {
  const refused = 'This tab only shows this Pip\'s own tab in Your Browser.';
  if (!request || typeof request !== 'object' || request.pip_id !== pipId) return refused;
  if (request.type === 'use_your_browser_view') return YOUR_BROWSER_OPS.has(request.op) && Object.keys(request).every((key) => YOUR_BROWSER_VIEW_FIELDS.has(key)) ? '' : refused;
  if (request.type === 'open_your_browser') return Object.keys(request).every((key) => key === 'type' || key === 'pip_id') ? '' : refused;
  return refused;
}
/** Your own tabs in Your Browser, streamed into an editor tab where the computer DGC runs on has no screen (Remote-SSH;
 *  his call, 18 Nov). Its page may ask for your own tab and nothing else (a frame, your own hand in it, the address bar,
 *  your tabs, its size), and no other page may ask for your own tab at all. */
const YOUR_OWN_OPS = new Set(['frame', 'input', 'go', 'back', 'forward', 'reload', 'new_tab', 'tab', 'close_tab', 'size', 'close', 'selection']);
const YOUR_OWN_FIELDS = new Set(['type', 'own', 'op', 'seq', 'events', 'tab', 'width', 'height', 'url']);
export function yourOwnTabRefusal(request: any): string {
  const refused = 'This tab only shows your own tabs in Your Browser.';
  if (!request || typeof request !== 'object' || request.type !== 'use_your_browser_view' || request.own !== true) return refused;
  return YOUR_OWN_OPS.has(request.op) && Object.keys(request).every((key) => YOUR_OWN_FIELDS.has(key)) ? '' : refused;
}
/** Whether a page other than Your Browser's own tab asks for your own tab: never let through. */
export function asksForYourOwnTab(request: any): boolean {
  return !!request && typeof request === 'object' && request.type === 'use_your_browser_view' && Object.prototype.hasOwnProperty.call(request, 'own');
}
export function yourBrowserDocument(scriptUri = '', styleUri = '', cspSource = '', title = 'Your Browser'): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data:; style-src ${attr(cspSource)} 'unsafe-inline'; script-src ${attr(cspSource)};"><link rel="stylesheet" href="${attr(styleUri)}"><title>${attr(title)}</title></head><body><main id="app"><p role="status">Connecting to local DGC…</p></main><script src="${attr(scriptUri)}"></script></body></html>`;
}
/** "Open in editor" for a Pip's chat: the Pip and the conversation a page names, each checked here. */
export type ChatPip = { id: string; name: string; pip_type: string; body?: string };
export type ChatConversation = { id: string; title?: string };
/** Several conversations a Pip (Pips API 79): before it a Pip has one chat, and its tab is that chat's. */
const CONVERSATIONS_API = 79;
const CHAT_PIP_TYPES = ['core', 'scout', 'lens', 'patch', 'rook', 'pulse', 'lock', 'quill'];
/** A Pip as a page names it, or undefined. `whole`: with its kind too (to open a tab); a tab saying what it shows
 *  names the Pip and its name only. */
export function chatPip(value: any, whole = true): ChatPip | undefined {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^pip_[A-Za-z0-9]{1,64}$/.test(value.id)) return undefined;
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 || /[\u0000-\u001f\u007f]/.test(value.name)) return undefined;
  if (whole && !CHAT_PIP_TYPES.includes(value.pip_type)) return undefined;
  // (`body`: the character chosen for it, as the page knows it, for its tab's first icon. DGC's own word follows.)
  return { id: value.id, name: value.name.trim(), pip_type: whole ? value.pip_type : String(value.pip_type || ''),
    ...(whole && typeof value.body === 'string' && CHAT_PIP_TYPES.includes(value.body) ? { body: value.body } : {}) };
}
/** A conversation as a page names it: undefined for none (the Pip's one chat, or its first), null for one that is not
 *  a conversation. Its id is DGC's, or '' for the Pip's first; its title a line of words, when the page knows it. */
export function chatConversation(value: any): ChatConversation | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^(?:conv_[0-9a-f]{32})?$/.test(value.id)) return null;
  if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 200 || /[\u0000-\u001f\u007f]/.test(value.title))) return null;
  return { id: value.id, ...(typeof value.title === 'string' && value.title.trim() ? { title: value.title.trim() } : {}) };
}
/** A chat tab's title: "{Pip name} · {conversation}", the conversation "Chat" until the page has said its name. */
export function chatTitle(pip: string, conversation?: string): string { return `${pip} · ${conversation || 'Chat'}`; }
const DRAFT_PART_KINDS = ['plugin', 'pip', 'file', 'project', 'link'];
/** A draft as a page says it, or undefined: its Pip, its conversation ('' the first), its words (up to a message's
 *  256 KB) and, when it has marks, its parts, which must spell those words. Passed on as it is checked here. */
export function chatDraftOf(message: any): { type: 'pipsChatDraft'; pip_id: string; conversation_id: string; text: string; parts?: unknown[] } | undefined {
  if (!message || typeof message.pip_id !== 'string' || !/^pip_[A-Za-z0-9]{1,64}$/.test(message.pip_id)) return undefined;
  if (typeof message.conversation_id !== 'string' || !/^(?:conv_[0-9a-f]{32})?$/.test(message.conversation_id)) return undefined;
  if (typeof message.text !== 'string' || message.text.length > 262144) return undefined;
  const parts = message.parts;
  if (parts !== undefined) {
    if (!Array.isArray(parts) || parts.length > 256) return undefined;
    const fine = parts.every((part: any) => typeof part === 'string' || part && typeof part === 'object' && DRAFT_PART_KINDS.includes(part.kind)
      && typeof part.label === 'string' && part.label.length <= 4096 && typeof part.wire === 'string' && part.wire.length <= 4096
      && typeof part.identity === 'string' && part.identity.length <= 128 && (part.pipType === undefined || typeof part.pipType === 'string' && part.pipType.length <= 40));
    if (!fine || parts.map((part: any) => typeof part === 'string' ? part : part.wire).join('') !== message.text) return undefined;
  }
  return { type: 'pipsChatDraft', pip_id: message.pip_id, conversation_id: message.conversation_id, text: message.text,
    ...(parts !== undefined ? { parts: parts.map((part: any) => typeof part === 'string' ? part : { kind: part.kind, label: part.label, wire: part.wire, identity: part.identity, ...(part.pipType !== undefined ? { pipType: part.pipType } : {}) }) } : {}) };
}
/** Continue in Work on a Pip's project change: what the panel opens Work with. */
export type ProjectWork = { name: string; change_id: string; file: string; patch: string; brief: string };
/** What a computer tab may ask for: its own Pip's computer, nothing else. */
/** What a computer tab may not ask ('' when it may): it is pinned to its own Pip and to the computer's commands. Saving
 *  a login is one of them only as the answer to a card its computer holds (15 Nov: a login's notification offers "Save
 *  login…" as its chat card does): the request names that card and its digest and never a site, so DGC saves the login
 *  for the site the Pip itself met, and nothing else about logins (listing, removing, sharing) is a computer tab's. */
export function computerTabRefusal(request: any, pipId: string): string {
  const refused = 'This tab only uses this Pip\'s computer.';
  if (!request || typeof request !== 'object') return refused;
  const own = (key: string) => Object.prototype.hasOwnProperty.call(request, key);
  if (own('pip_id') && request.pip_id !== pipId) return refused;
  if (request.type === 'save_pip_login') return request.pip_id === pipId && typeof request.action_id === 'string' && /^compact_[a-f0-9]{32}$/.test(request.action_id)
    && typeof request.expected_digest === 'string' && !own('site') ? '' : refused;
  // The code card (Pips API 98): the code a site sent, typed on the notification of the card this computer holds. The
  // request names this Pip, that card and its digest, and carries the code and nothing else: no site, no page, no login.
  if (request.type === 'fill_pip_code') return request.pip_id === pipId && typeof request.action_id === 'string' && /^compact_[a-f0-9]{32}$/.test(request.action_id)
    && typeof request.expected_digest === 'string' && /^[a-f0-9]{64}$/.test(request.expected_digest) && typeof request.code === 'string' && request.code.length <= 64
    && Object.keys(request).every((key) => FILL_CODE_FIELDS.has(key)) ? '' : refused;
  return COMPUTER_COMMANDS.has(request.type) ? '' : refused;
}
const FILL_CODE_FIELDS = new Set(['type', 'pip_id', 'action_id', 'expected_digest', 'code']);
/** fill_pip_code is Pips API 98 (the code card). What a page may not send as one ('' when it may): an older DGC has no
 *  such card, and the request is the card, its digest and the code, nothing more. The code is passed on to DGC and is
 *  never kept or logged here (what this host remembers of a request in flight is its command's name). */
export const CODE_CARD_API = 98;
export function fillCodeRefusal(request: any, apiVersion: number): string {
  if (request?.type !== 'fill_pip_code') return '';
  if (apiVersion < CODE_CARD_API) return 'Update DGC to type a site’s code for a Pip.';
  return typeof request.pip_id === 'string' && typeof request.action_id === 'string' && /^compact_[a-f0-9]{32}$/.test(request.action_id)
    && typeof request.expected_digest === 'string' && typeof request.code === 'string' && request.code.length <= 64
    && Object.keys(request).every((key) => FILL_CODE_FIELDS.has(key)) ? '' : 'That card is not a code to type.';
}
const COMPUTER_COMMANDS = new Set(['get_pip_computer','open_pip_computer','use_pip_computer_view','stop_pip_computer','list_pip_computer_actions','decide_pip_computer_action','always_allow_pip_computer_action','list_pip_computer_files','read_pip_computer_file','add_pip_computer_file','remove_pip_computer_file','run_pip_computer_command','list_pip_computer_terminal','get_pip_computer_desktop','get_pip_computer_apps','set_pip_computer_apps','set_pip_computer_screen']);
const PIP_TYPES = ['core','scout','lens','patch','rook','pulse','lock','quill'];
/** Big files into and out of a Pip computer's Files (pc-background-commands, Pips API 87): copy_pip_computer_file_in
 *  {pip_id, path, source} and copy_pip_computer_file_out {pip_id, path, target}. `source` and `target` are paths on the
 *  computer running DGC, so no page ever sends these commands: a computer tab says only which folder or file in Files
 *  (pipComputerAddFiles {folder}, pipComputerSaveAs {path}) and this host shows VS Code's own dialog and sends the path
 *  the user picked there. In a remote window that dialog shows the remote machine's files, which is where DGC runs:
 *  one more reason the host, not the page, picks the paths. */
const COMPUTER_COPY_COMMANDS = new Set(['copy_pip_computer_file_in', 'copy_pip_computer_file_out']);
const COMPUTER_COPY_API = 87;
/** A folder or file in a Pip computer's Files, as a page may name it: DGC checks it again (dgc/pip_computer_files.py). */
const filesPath = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && !value.includes('\0')
  && !value.startsWith('/') && !value.split('/').some(part => part === '..' || part === '.');
/** A copy can take minutes (1 GB): it waits this long for DGC's answer, not a read's 20 seconds. */
const COMPUTER_COPY_WAIT_MS = 30 * 60 * 1000;
type ComputerPip = { id: string; name: string; pip_type: string };

/** DGC's own side bar view, as Full screen needs it: whether it is showing, and how to show it again. */
export type FullScreenSide = { visible(): boolean; show(): void };
const FULL_HIDE = 'workbench.action.maximizeEditorHideSidebar', FULL_TOGGLE = 'workbench.action.toggleMaximizeEditorGroup';
/** Full screen in a Pip computer's tab (0.52): the tab says when it goes on and off (pipComputerFull {on}), and this
 *  gives the computer the window with VS Code's own command: "Maximize Editor Group and Hide Side Bars", or, where this
 *  VS Code has no such command, the editor group alone. VS Code's window full screen (F11) stays the user's own.
 *
 *  One for the whole window, whichever Pips page opened the tab: the command runs when the first tab goes on, and things
 *  are put back when the last one goes off (or closes), once. So two computer tabs never undo each other.
 *
 *  Put back is only what this changed and can tell it changed. VS Code tells an extension neither whether a side bar is
 *  showing nor whether a group is maximized, so: the editor group is given back its size only when there was more than
 *  one group to maximize over, and DGC's own side bar view is shown again only when it was showing before. A side bar
 *  showing something else is the user's to open again. */
export class ComputerFullScreen {
  private tabs = new Set<object>();
  private changed: { maximized: boolean; side?: FullScreenSide } | undefined;
  private work: Promise<void> = Promise.resolve();
  /** A tab's Full screen went on or off. Resolves when the window has followed. */
  set(tab: object, on: boolean, side?: FullScreenSide): Promise<void> {
    if (on === this.tabs.has(tab)) return this.work;
    if (on) this.tabs.add(tab); else this.tabs.delete(tab);
    return this.work = this.work.then(() => this.follow(side)).catch(() => { /* a command VS Code refused changes nothing here */ });
  }
  private async follow(side?: FullScreenSide): Promise<void> {
    const want = this.tabs.size > 0, commands = vscode.commands;
    if (want === !!this.changed || !commands) return;
    const groups = () => vscode.window.tabGroups?.all.length ?? 1;
    if (want) {
      const all = await commands.getCommands(true), many = groups() > 1;
      if (all.includes(FULL_HIDE)) {
        this.changed = { maximized: many && all.includes(FULL_TOGGLE), ...(side?.visible() === true ? { side } : {}) };
        await commands.executeCommand(FULL_HIDE);
      } else if (many && all.includes(FULL_TOGGLE)) {
        this.changed = { maximized: true };
        await commands.executeCommand(FULL_TOGGLE);
      } else this.changed = { maximized: false };
      return;
    }
    const was = this.changed!; this.changed = undefined;
    try { if (was.maximized && groups() > 1) await commands.executeCommand(FULL_TOGGLE); }
    finally { if (was.side && !was.side.visible()) was.side.show(); }
  }
}
export const computerFullScreen = new ComputerFullScreen();

/** Local Pips control bridge. Request correlation is owned by the extension host. */
/** Fix on a Pip whose routines can't run because its Claude Code or Codex is signed out (Pips package 2): that CLI's own
 * sign-in, in a terminal on the computer running DGC (over Remote-SSH, the remote one). DGC never touches the login. The
 * Pips tab and the Pips inside the DGC panel both ask for it. */
export function openEngineSignIn(engine: string): void {
  const login = ({ claude: { name: 'Claude Code', command: 'claude' }, codex: { name: 'Codex', command: 'codex login' } } as
    Record<string, { name: string; command: string }>)[engine];
  if (!login) { return; }
  const terminal = vscode.window.createTerminal({ name: `Sign in to ${login.name}` });
  terminal.show();
  terminal.sendText(login.command, true);
}

export class PipsEditor implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private panelNavigation?: { pip: string; section?: 'chat' | 'runs'; run?: string } | { overview: true };
  private embeddedPost?: (message: any) => void;
  /** The open computer tabs, by Pip and (from Pips API 86, when the page says which) the computer's number: "pip_x:2". */
  private computers = new Map<string, { panel: vscode.WebviewPanel; pip: ComputerPip; number?: number }>();
  /** "Open in editor" (15 Nov): the open editor tabs of Pip chats, one per Pip conversation, by "pip_x#conv_y" (the
   *  Pip's first conversation: "pip_x#"). Each is the Pips page itself, pinned to that chat and talking to DGC through
   *  this bridge as the Pips tab does: the same chat, never a copy. Closing one asks DGC nothing. */
  private chats = new Map<string, { panel: vscode.WebviewPanel; pip: ChatPip; conversation: string; face?: string }>();
  /** A Pip's streamed tab of Your Browser, one per Pip (Pips API 107); and (key "own") your own tab, streamed where the
   *  computer DGC runs on has no screen, one per window. */
  private browserTabs = new Map<string, { panel: vscode.WebviewPanel; pip: { id: string; name: string } | null }>();
  /** The character each Pip wears, as DGC last said it in this window (get_pip, set_pip_profile): '' for its type's own. */
  private static faces = new Map<string, string>();
  /** Every bridge of this window (the side bar's, the Pips tab's): what is typed in one page of a chat is told to
   *  all the others, whichever bridge they are on. */
  private static readonly bridges = new Set<PipsEditor>();
  /** A conversation's draft as a page last said it, so a tab opened later starts with what is in the box. Words and
   *  marks only, in memory only, a few at a time. */
  private static readonly drafts = new Map<string, any>();
  /** Who opens a chat's tab when a page asks: the window's one keeper of them (the panel sets it). None: this bridge. */
  private chatOpener?: (pip: ChatPip, conversation?: ChatConversation) => void;
  useOpenChat(open: (pip: ChatPip, conversation?: ChatConversation) => void): void { this.chatOpener = open; }
  /** Where a job a Pip was handed came from (Pips API 111), from the "From …" line in its chat: that Work session, that
   *  ChatDGC chat, or that Pip. Set by the panel; the page names a kind and an id, nothing else. */
  private askerOpener?: (asker: { kind: 'work' | 'chatdgc' | 'pip'; id: string; title: string }) => void;
  useOpenAsker(open: (asker: { kind: 'work' | 'chatdgc' | 'pip'; id: string; title: string }) => void): void { this.askerOpener = open; }
  /** Each Pip's computers by name, as DGC last said them (get_pip_computer, rename_pip_computer, add_pip_computer). */
  private computerNames = new Map<string, { number: number; name: string }[]>();
  /** The computer tabs with an Add file… or Save to this computer… under way (a dialog open, or a copy running): one at a time each. */
  private computerCopying = new Set<string>();
  /** The copies DGC has not answered yet: ended, in words, when the connection changes under them. */
  private computerCopies = new Set<(why: string) => void>();
  /** DGC's side bar view, set by the panel: Full screen in a computer tab hides the side bars, and shows this one again after. */
  fullScreenSide?: FullScreenSide;
  /** One screen stream per Pip: the tab (its key in `computers`) that opened it last. */
  private desktopOwner = new Map<string, string>();
  /** The CLI streams a Pip computer's full screen (ready.capabilities.pips_desktop). */
  private desktopStream = false;
  /** The CLI's screen stream takes which computer (ready.capabilities.pips_desktop_numbers). */
  private desktopNumbers = false;
  /** /learn in a Pip's chat (ready.capabilities.learn): learn_skill drafts, save_skill writes a personal skill. */
  private learn = false;
  private pending = new Map<string, { client: string; command: string; at: number; surface?: string; pip?: string; document?: { run: string; save: boolean; generation: number }; exportFile?: { generation: number }; exportTeam?: { generation: number }; keptImage?: { pip: string; message: string; index: number; generation: number }; spooled?: string[]; newsDismiss?: { pipIds: string[]; until: string } }>();
  private generation = 0;
  private apiVersion = 0;
  /** The backend's image spool (ready.capabilities.image_spool_dir), where a Pip message's photos and files go from API 52. */
  private spoolDir = '';
  private backendIdentity?: object;
  private backgroundSetup = false;
  private displayMentions = false;
  private state: { connected: boolean; supported: boolean; enabled: boolean } = { connected: false, supported: false, enabled: false };
  private connectFailed = false;
  /** Reads the extension host makes for itself (the attention watcher), never a webview's. */
  private hostReads = new Map<string, (event: any) => void>();
  /** Dictation for the Pip chat's box (src/voice.ts), in this tab of its own; the side bar routes its own. */
  private dictation?: () => Dictation;
  private readAloud?: () => ReadAloud;
  private readonly mic: DictationOwner = { post: (message) => this.post({ ...message, from: 'pips' }) };
  useDictation(dictation: () => Dictation, readAloud?: () => ReadAloud): void { this.dictation = dictation; this.readAloud = readAloud; }
  /** A plugin's logo by its id (a data: URI), for a reply's "Used Aave" line; "" when it has none. */
  private savedProviders?: { list: () => Promise<unknown[]>; save: (id: string, model: string) => Promise<void>; none: () => boolean; host: () => unknown };
  private pluginLogo?: (plugin: string) => string;
  usePluginLogos(lookup: (plugin: string) => string): void { this.pluginLogo = lookup; }
  /** Providers saved in Settings: the host lists them for a Pip's model menus, and saves one (with its key, which never
   *  comes here) before a Pip is set to it. */
  /** `host`: the name and mark of the host DGC itself is on, for the model picker's "your connection" (never its address). */
  /** The most tokens a model takes (Pips API 104: a Pip's Sub-agents page), asked of the window's DGC (model_window_at)
   *  by the panel, which knows a saved provider's address and key; 0 when it can't say. */
  private modelWindow?: (choice: { mode: 'model' | 'provider'; model: string; provider?: string }) => Promise<number>;
  useModelWindow(ask: (choice: { mode: 'model' | 'provider'; model: string; provider?: string }) => Promise<number>): void { this.modelWindow = ask; }
  useSavedProviders(list: () => Promise<unknown[]>, save: (id: string, model: string) => Promise<void>, none: () => boolean = () => false, host: () => unknown = () => undefined): void { this.savedProviders = { list, save, none, host }; }
  /** ChatGPT · your plan and the usage meter in a Pip's chat (0.52), the panel's: the plan's sign-in state when no saved
   *  provider is the plan (`offer`, "" for none: the picker then offers Connect); Connect and Cancel from the picker
   *  (its steps said to the page as planConnecting); and the meter for a Pip's model choice. Page messages, never Pip
   *  controls: none reaches DGC's Pips. */
  private planHooks?: { offer: () => Promise<string>; connect: (say: (message: Record<string, unknown>) => void, id: string) => Promise<boolean>; cancel: () => void;
    usage: (choice: unknown, fresh: boolean) => Promise<Record<string, unknown>>; openUsage: (source: unknown, page: unknown) => void };
  usePlan(hooks: NonNullable<PipsEditor['planHooks']>): void { this.planHooks = hooks; }
  /** A new usage report: each Pip's chat asks for its meter again. */
  usageChanged(): void { this.postPages({ type: 'pipUsageChanged' }); }
  /** A reply's links and Settings → Models, on the page in its own tab. The side bar's page shares the panel's own. */
  private pageActions?: (message: any) => void;
  usePageActions(act: (message: any) => void): void { this.pageActions = act; }
  /** The artifacts (Pips API 67): a Pip's page lists the person's dashboards to refresh, and opens its report's
   *  document or sheet and its dashboards in the artifact panel. */
  private artifacts?: () => PipArtifactsHub | undefined;
  useArtifacts(hub: () => PipArtifactsHub | undefined): void { this.artifacts = hub; }
  /** A reply's pictures folded or opened (media/pictureFold.js): kept by the extension (src/pictureFolds.ts), and
   *  what was kept, with the setting, given to the page as it opens. */
  private folds?: { remember: (message: any) => boolean; initial: () => any };
  useFolds(remember: (message: any) => boolean, initial: () => any): void { this.folds = { remember, initial }; }
  /** The dock (src/dock.ts): a Pip's pin on its row. The page is told what is pinned as it opens and whenever it changes. */
  private dock?: { handle: (message: any, reply: (state: any) => void) => boolean; state: () => any };
  useDock(handle: (message: any, reply: (state: any) => void) => boolean, state: () => any): void { this.dock = { handle, state }; }
  dockChanged(): void { if (this.dock) this.postPages(this.dock.state()); }
  /** Settings changed Pictures in replies: the page follows it. */
  picturesSetting(message: any): void { this.postPages(message); }
  private newsDismissed?: (pipIds: string[], until: string) => void;
  useNewsDismissed(notify: (pipIds: string[], until: string) => void): void { this.newsDismissed = notify; }
  /** A Pip's messages were marked read here (mark_pip_read answered): the home's count and the other Pips pages follow. */
  private unreadRead?: () => void;
  useUnreadRead(notify: () => void): void { this.unreadRead = notify; }
  /** A new-Pip card was created or turned down here (accept_pip_setup or reject_pip_setup answered): the same card in
   *  every other chat and Pips page follows at once (Reject turns it down everywhere, 11 Nov). */
  private setupDecided?: (setupId: string) => void;
  useSetupDecided(notify: (setupId: string) => void): void { this.setupDecided = notify; }
  /** A new-Pip card was decided somewhere else: this page's copy reads it again. */
  setupChanged(setupId: string): void { this.postPages({ type: 'pipSetupChanged', setup_id: setupId }); }
  private profileChangeNotice?: () => void;
  useProfileChanged(notify: () => void): void { this.profileChangeNotice = notify; }
  profileChanged(): void { this.postPages({ type: 'pipsProfileChanged' }); }
  /** A video's Stop from a Pip's chat: the window's backend (videos_stop), set by the panel. */
  videoStop?: (job: string) => Promise<Record<string, unknown> | undefined>;
  /** A Pip reply's running video: the window's backend polls (or watches) it, so one a restart left on disk ends. */
  videoFollow?: (job: string) => void;
  /** Continue in Work on what a Pip changed in its copy of a project (Pips API 91): a new Work chat in this window's
   *  folder, `brief` in its box and the patch beside it as a file. False when no chat opened. Set by the panel. */
  private projectWork?: (work: ProjectWork) => Promise<boolean>;
  useProjectWork(open: (work: ProjectWork) => Promise<boolean>): void { this.projectWork = open; }
  /** The Project Folder dropdown's choice ("" is All projects), kept by the extension for every window, and how one
   *  made here is kept. Set by the panel. The view is told the choice as it connects and whenever it changes. */
  private projectFolderHook?: { choice: () => string; choose: (folder: string) => void };
  useProjectFolder(hook: { choice: () => string; choose: (folder: string) => void }): void { this.projectFolderHook = hook; }
  projectFolderChanged(): void { if (this.foldersOn && this.projectFolderHook) this.post({ type: 'pipsProjectFolder', folder: this.projectFolderHook.choice() }); }
  /** This DGC offers the dropdown (it lists folders and every project's sessions). */
  private foldersOn = false;
  /** The folders DGC listed and the ones the editor's folder picker gave: what can be chosen, and added as a project. */
  private readonly listedFolders = new Set<string>();
  private readonly pickedFolders = new Set<string>();
  /** A Pip's workspace, read from DGC: which project it belongs to (Ask DGC to fix opens Work in that project's folder). */
  async pipWorkspace(pipId: string): Promise<string> {
    if (!/^pip_[0-9a-f]{32}$/.test(pipId)) return '';
    const got = await this.hostAsk('get_pip', { pip_id: pipId });
    return got?.pip?.id === pipId && typeof got.pip.workspace_id === 'string' ? got.pip.workspace_id : '';
  }
  /** Add a folder…: the editor's own folder picker, so only a folder that exists. What it gave may be added as a project. */
  private async pickFolder(id: string, surface: string): Promise<void> {
    let folder: string | null = null;
    try {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Add folder', title: 'Add a folder: a Project Pip works in it' });
      folder = fullFolder(picked?.[0]?.fsPath) || null;
    } catch { folder = null; }
    if (folder) { if (this.pickedFolders.size >= 64) this.pickedFolders.clear(); this.pickedFolders.add(folder); }
    this.post({ type: 'pipsFolderPicked', id, folder }, surface);
  }
  private workSessions?: (pipId?: string) => Promise<Array<{ id: string; title: string; empty?: true }>>;
  /** The Work sessions of the folder this window has open, by the titles its list shows (for a Project Pip's owner). */
  /** (With the Project Folder dropdown the page says which Pip: a Project Pip of another folder reports to a session
   *  of its own folder, so the titles are that folder's.) */
  useWorkSessions(list: (pipId?: string) => Promise<Array<{ id: string; title: string; empty?: true }>>): void { this.workSessions = list; }
  /** The Project Pips a Work session is the owner of: what deleting or archiving it asks about. None on a DGC before
   *  Pips API 89 (it keeps no owner), or while Pips are off. */
  async sessionPips(sessionId: string): Promise<OwnedPip[]> {
    // From Pips API 96 no session owns a Pip (pips-flow-design Q2): list_session_pips is gone.
    if (!this.state.connected || !this.state.supported || !this.state.enabled || this.apiVersion < OWNERS_API || this.apiVersion >= 96 || !SESSION_ID.test(sessionId)) return [];
    const result = await this.hostAsk('list_session_pips', { session_id: sessionId });
    if (result?.session_id !== sessionId || !Array.isArray(result.pips)) throw new Error('DGC answered about another session. Try again.');
    return result.pips.filter((p: any) => p && typeof p.id === 'string' && /^pip_[0-9a-f]{32}$/.test(p.id) && typeof p.name === 'string' && p.name)
      .slice(0, 200).map((p: any) => ({ id: p.id, name: p.name.slice(0, 120), pip_type: String(p.pip_type || '').slice(0, 40), status: String(p.status || '').slice(0, 40) }));
  }
  /** The Pips a session is related to (list_related_pips, Pips API 96; pips-flow-design Q2), strongest first, for its
   *  agent map; and how many Pips are elsewhere: every Pip of list_pips scope all that is not related, the archived
   *  ones left out (read a page at a time, five pages at most; none when it can't be read). It orders and shows, it
   *  never routes. Null on a DGC before API 96 or while Pips are off: it is never asked. */
  async relatedPips(sessionId: string): Promise<{ pips: RelatedPip[]; elsewhere: number } | null> {
    if (!this.state.connected || !this.state.supported || !this.state.enabled || this.apiVersion < RELATED_API || !SESSION_ID.test(sessionId)) return null;
    const result = await this.hostAsk('list_related_pips', { session_id: sessionId });
    if (result?.session_id !== sessionId || !Array.isArray(result.pips)) throw new Error('DGC answered about another session. Try again.');
    const pips: RelatedPip[] = result.pips.filter((p: any) => p && typeof p.id === 'string' && /^pip_[0-9a-f]{32}$/.test(p.id)).slice(0, 100)
      .map((p: any) => ({ id: p.id, name: (typeof p.name === 'string' && p.name ? p.name : 'Pip').slice(0, 120), pip_type: String(p.pip_type || '').slice(0, 40),
        why: (Array.isArray(p.why) ? p.why : []).filter((w: unknown) => w === 'asked' || w === 'set_up' || w === 'folder'),
        running: p.running === true, needs_you: Number.isSafeInteger(p.needs_you) && p.needs_you > 0 ? p.needs_you : 0 }));
    const related = new Set(pips.map(p => p.id));
    let elsewhere = 0;
    try {
      for (let offset = 0, page = 0; page < 5; page++) {
        const listed = await this.hostAsk('list_pips', { scope: 'all', limit: 100, offset });
        if (!Array.isArray(listed?.pips)) break;
        for (const pip of listed.pips) if (pip && typeof pip.id === 'string' && pip.status !== 'archived' && !related.has(pip.id)) elsewhere++;
        if (!Number.isSafeInteger(listed.next_offset) || listed.next_offset <= offset) break;
        offset = listed.next_offset;
      }
    } catch { elsewhere = 0; }
    return { pips, elsewhere };
  }
  /** Stop on the agent map's Pips section: the existing cancel_pip_run for that one run. DGC's own words when it refuses. */
  async stopPipRun(runId: string): Promise<void> {
    if (!/^run_[0-9a-f]{32}$/.test(runId)) throw new Error('That is not a run.');
    await this.hostAsk('cancel_pip_run', { run_id: runId });
  }
  /** Each of them to another session of its project (null: no session, its reports wait in the Pips view), one at a
   *  time. The first DGC refuses stops it, named. */
  async moveSessionPips(pips: OwnedPip[], sessionId: string | null): Promise<void> {
    for (const pip of pips) {
      try {
        const result = await this.hostAsk('set_pip_owner', { pip_id: pip.id, session_id: sessionId });
        if (result?.pip_id !== pip.id || (result.session_id ?? null) !== sessionId) throw new Error('DGC answered about another Pip. Try again.');
      } catch (error) { throw new Error(`${pip.name}: ${error instanceof Error && error.message ? error.message : 'DGC couldn’t move it.'}`); }
    }
  }
  /** Each of them deleted as the Pips view deletes one: archived (unless it is already), then deleted for good under
   *  its own name. The first DGC refuses stops it, named: work still running must finish or be stopped first. */
  async deleteSessionPips(pips: OwnedPip[]): Promise<void> {
    for (const pip of pips) {
      try {
        let now = (await this.hostAsk('get_pip', { pip_id: pip.id }))?.pip;
        const whole = (p: any) => p && p.id === pip.id && typeof p.name === 'string' && Number.isSafeInteger(p.current_version) && Number.isSafeInteger(p.lifecycle_revision);
        if (!whole(now)) throw new Error('DGC answered about another Pip. Try again.');
        if (now.status !== 'archived') {
          now = (await this.hostAsk('archive_pip', { pip_id: pip.id, expected_version: now.current_version, expected_lifecycle_revision: now.lifecycle_revision,
            request_key: 'owner-' + randomBytes(16).toString('hex'), reason: 'Deleted with its owner session.' }))?.pip;
          if (!whole(now) || now.status !== 'archived') throw new Error('DGC didn’t confirm it was archived. Refresh, then try again.');
        }
        const gone = await this.hostAsk('delete_archived_pip', { pip_id: pip.id, expected_name: now.name, expected_version: now.current_version, expected_lifecycle_revision: now.lifecycle_revision });
        if (gone?.deleted !== true || gone.pip_id !== pip.id) throw new Error('DGC didn’t confirm the deletion. Refresh, then try again.');
      } catch (error) { throw new Error(`${pip.name}: ${error instanceof Error && error.message ? error.message : 'DGC couldn’t delete it.'}`); }
    }
  }
  constructor(private readonly extensionUri: vscode.Uri, private readonly send: (message: any, backendIdentity?: object) => boolean, private readonly connect: () => void, private readonly requireGeneration = false) { PipsEditor.bridges.add(this); }
  attach(post: (message: any) => void): void {
    // The main panel is now the primary surface. Retire any old editor instance
    // before changing the reply destination, so requests cannot cross surfaces.
    this.panel?.dispose();
    this.pending.clear();
    this.generation++;
    this.embeddedPost = post;
  }
  private post(message: any, surface = 'main'): void {
    if (surface.startsWith('computer:')) { void this.computers.get(surface.slice(9))?.panel.webview.postMessage(message); return; }
    if (surface.startsWith('browser:')) { void this.browserTabs.get(surface.slice(8))?.panel.webview.postMessage(message); return; }
    if (surface.startsWith('chat:')) { void this.chats.get(surface.slice(5))?.panel.webview.postMessage(message); return; }
    if (this.embeddedPost) this.embeddedPost(message);
    else this.panel?.webview.postMessage(message);
  }
  /** To the Pips page and to every chat's own tab: what any page showing Pips needs to hear. */
  private postPages(message: any, except = ''): void {
    if (except !== 'main') this.post(message);
    for (const key of this.chats.keys()) if ('chat:' + key !== except) this.post(message, 'chat:' + key);
  }
  /** To every page of every bridge in this window but the one that said it. */
  private tellOthers(message: any, from: string): void {
    for (const bridge of PipsEditor.bridges) { try { bridge.postPages(message, bridge === this ? from : ''); } catch { /* a page that has gone */ } }
  }
  /** The webview a page's own replies go to (videos, a plugin's card): the Pips tab, or a chat's tab. */
  private pagePanel(surface: string): vscode.WebviewPanel | undefined {
    return surface.startsWith('chat:') ? this.chats.get(surface.slice(5))?.panel : this.panel;
  }
  /** Settings saved, or the Router's settings changed: what a Pip on Default runs on may have changed with them (Pips run
   *  on, the Router on or off, its Pip systems), so an open Pips page reads list_pip_models again. */
  modelsChanged(): void { this.postPages({ type: 'pipsModelsChanged' }); }
  /** A Pip was marked read somewhere else: an open Pips page reads its unread counts again. */
  unreadChanged(): void { this.postPages({ type: 'pipsUnreadChanged' }); }
  /** Open a Pip's chat as an editor tab, or bring its tab forward: "{Pip name} · {conversation}", one tab per Pip
   *  conversation, as a Work session and a ChatDGC chat each have their own. It needs nothing new of DGC: the tab is the
   *  Pips page on this bridge, so it is there on any DGC that has Pips (one before several conversations, Pips API 79,
   *  has one chat a Pip: "{Pip name} · Chat"). Its title is a first word on it: the page says what it shows once it has
   *  read it from DGC (pipsChatShown), and the title follows. */
  openChat(pip: ChatPip, conversation?: ChatConversation): void {
    const conv = this.apiVersion >= CONVERSATIONS_API && conversation ? conversation.id : '';
    const key = `${pip.id}#${conv}`;
    const open = this.chats.get(key);
    if (open) { open.panel.reveal(vscode.ViewColumn.Active); return; }
    const title = chatTitle(pip.name, this.apiVersion >= CONVERSATIONS_API ? conversation?.title : undefined);
    const panel = vscode.window.createWebviewPanel('dgc.pipChat', title, vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri],
    });
    const tab: { panel: vscode.WebviewPanel; pip: ChatPip; conversation: string; face?: string } = { panel, pip, conversation: conv };
    this.chats.set(key, tab);
    // Its tab wears its face (16 Nov), as a computer's tab wears its Portal: the character DGC last said it wears, else
    // the one its opener named, else its type's.
    this.wearFace(tab, PipsEditor.faces.has(pip.id) ? PipsEditor.faces.get(pip.id) : pip.body);
    const surface = () => 'chat:' + this.chatKey(tab);
    panel.onDidDispose(() => {
      const at = this.chatKey(tab);
      if (this.chats.get(at) === tab) this.chats.delete(at);
      for (const [id, item] of this.pending) if (item.surface === 'chat:' + at) this.pending.delete(id);
    });
    const focused = () => { try { return vscode.window.state?.focused !== false; } catch { return true; } };
    panel.onDidChangeViewState(() => panel.webview.postMessage({ type: 'pipsVisibility', visible: panel.visible, focused: focused() }));
    try { const watch = vscode.window.onDidChangeWindowState?.(() => { void panel.webview.postMessage({ type: 'pipsVisibility', visible: panel.visible, focused: focused() }); }); if (watch) panel.onDidDispose(() => watch.dispose()); } catch { /* an editor that does not say */ }
    panel.webview.onDidReceiveMessage(message => this.receive(message, surface()));
    panel.webview.html = this.pageHtml(panel, { pip: pip.id, conversation: conv });
    this.connect();
  }
  /** A chat tab's icon: its Pip's face. Set only when the face changes (an editor draws a tab again when its icon is set). */
  private wearFace(tab: { panel: vscode.WebviewPanel; pip: ChatPip; face?: string }, body: unknown): void {
    const face = pipFace(tab.pip.pip_type, body);
    if (!face || tab.face === face) return;
    const icon = pipTabFace(this.extensionUri, face);
    if (!icon) return;
    try { tab.panel.iconPath = icon; tab.face = face; } catch { /* a tab on its way out */ }
  }
  /** DGC said which character a Pip wears (its profile's body; none: its type's own): every chat tab of that Pip, on
   *  every bridge of this window, wears it from now. Never from what a page says. */
  private static faceSaid(pipId: unknown, profile: unknown): void {
    if (typeof pipId !== 'string' || !/^pip_[A-Za-z0-9]{1,64}$/.test(pipId)) return;
    const body = profile && typeof profile === 'object' && typeof (profile as any).body === 'string' ? (profile as any).body : '';
    PipsEditor.faces.delete(pipId);
    PipsEditor.faces.set(pipId, body);
    if (PipsEditor.faces.size > 512) PipsEditor.faces.delete(PipsEditor.faces.keys().next().value!);
    for (const bridge of PipsEditor.bridges) for (const tab of bridge.chats.values()) if (tab.pip.id === pipId) bridge.wearFace(tab, body);
  }
  /** Where a chat's tab is kept now (its conversation may have changed under it: chatShown). */
  private chatKey(tab: { pip: ChatPip; conversation: string }): string { return `${tab.pip.id}#${tab.conversation}`; }
  /** A chat's tab says what it shows (its Pip's name and its conversation, as read from DGC): its title follows a
   *  rename. A tab that now shows another conversation (its own is gone: the first one, then) is kept under that one;
   *  if that one already has a tab, this one closes and that one comes forward, so two tabs never show one chat. */
  private chatShown(surface: string, message: any): void {
    const tab = this.chats.get(surface.slice(5)), shown = chatPip(message?.pip, false), conversation = chatConversation(message?.conversation);
    if (!tab || !shown || shown.id !== tab.pip.id || conversation === null || !conversation) return;
    const conv = this.apiVersion >= CONVERSATIONS_API ? conversation.id : '';
    if (conv !== tab.conversation) {
      const there = this.chats.get(`${tab.pip.id}#${conv}`);
      if (there && there !== tab) { tab.panel.dispose(); there.panel.reveal(vscode.ViewColumn.Active); return; }
      const before = 'chat:' + this.chatKey(tab);
      this.chats.delete(this.chatKey(tab));
      tab.conversation = conv;
      this.chats.set(this.chatKey(tab), tab);
      for (const item of this.pending.values()) if (item.surface === before) item.surface = 'chat:' + this.chatKey(tab);
    }
    tab.pip = { ...tab.pip, name: shown.name };
    const title = chatTitle(shown.name, conversation.title);
    if (tab.panel.title !== title) tab.panel.title = title;
  }
  /** The Pips page's document for one of this bridge's tabs, its favicons as dgc.linkFavicons stands now. */
  private pageHtml(panel: vscode.WebviewPanel, chat?: { pip: string; conversation: string }): string {
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', name)).toString();
    const media = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name)).toString();
    let favicons = true;
    try { favicons = vscode.workspace.getConfiguration('dgc').get<boolean>('linkFavicons', true) !== false; } catch { favicons = false; }
    return pipsDocument(asset('pips.js'), asset('pips.css'), panel.webview.cspSource, asset('markdown.js'),
                        media('mcpApps.js'), media('mcpApps.css'), media('videoPlayer.js'), media('codicon.css'), { favicons, ...(chat ? { chat } : {}) });
  }
  /** What a page typed in a conversation's box, told to every other page of this window; '' when it sent it or
   *  cleared it. Words and marks only, as the page's own saved state keeps them. Nothing is sent to DGC. */
  private chatDraft(surface: string, message: any): void {
    const draft = chatDraftOf(message);
    if (!draft) return;
    const key = `${draft.pip_id}#${draft.conversation_id}`;
    PipsEditor.drafts.delete(key);
    if (draft.text) { PipsEditor.drafts.set(key, draft); if (PipsEditor.drafts.size > 64) PipsEditor.drafts.delete(PipsEditor.drafts.keys().next().value!); }
    this.tellOthers(draft, surface);
  }
  /** Open a Pip's computer as an editor tab, or bring its tab forward: "Gmail · Computer", and one tab for each computer
   *  by its name ("Gmail · Juniper") when the page says which (Pips API 86). */
  openComputer(pip: ComputerPip, number?: number): void {
    const key = number ? `${pip.id}:${number}` : pip.id;
    const open = this.computers.get(key);
    if (open) { open.panel.reveal(vscode.ViewColumn.Active); return; }
    const title = this.computerTitle(pip, number);
    const panel = vscode.window.createWebviewPanel('dgc.pipComputer', title, vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri],
    });
    // Its tab's icon is this computer's Portal at rest, in its number's palette (media/session-icons/portal-*.png):
    // "Desk · Poppy" and "Desk · Studio" look different. The same palette as in the menu, on the Pip's page and in the
    // tab's own bar; a Pip's one computer is its first.
    const icon = markIcon(this.extensionUri, 'portal', marks.computerPalette(number ?? 1));
    if (icon) panel.iconPath = icon;
    const surface = 'computer:' + key;
    this.computers.set(key, { panel, pip, ...(number ? { number } : {}) });
    panel.onDidDispose(() => {
      this.computers.delete(key);
      void computerFullScreen.set(panel, false);   // a tab closed in Full screen: the window is put back
      for (const [id, item] of this.pending) if (item.surface === surface) this.pending.delete(id);
      // Pips API 88: its tab is gone, so DGC lets its live view go and the computer reads closed at once, not after
      // the view's ten idle minutes.
      if (this.apiVersion >= 88 && this.state.connected && this.state.supported && this.state.enabled) {
        const requestId = 'pips-view-close-' + randomBytes(12).toString('hex');
        this.hostReads.set(requestId, () => { this.hostReads.delete(requestId); });
        if (!this.send({ type: 'pips_control', request: { type: 'use_pip_computer_view', pip_id: pip.id, op: 'close',
          ...(number ? { number } : {}), request_id: requestId } }, this.backendIdentity)) this.hostReads.delete(requestId);
      }
      // One stream per Pip: only the tab that has it closes it.
      const owner = this.desktopOwner.get(pip.id);
      if (owner !== undefined && owner !== key) return;
      this.desktopOwner.delete(pip.id);
      if (this.desktopStream && this.state.connected) this.send({ type: 'pip_desktop', pip_id: pip.id, op: 'close' }, this.backendIdentity);
    });
    panel.webview.onDidReceiveMessage(message => this.receive(message, surface));
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', name)).toString();
    panel.webview.html = computerDocument(asset('pipComputer.js'), asset('pipComputer.css'), panel.webview.cspSource, title);
  }
  /** A Pip's tab in Your Browser as an editor tab beside the chat ("Ava · Your Browser"), or its tab brought forward.
   *  With no Pip (null): your own tab, streamed where the computer DGC runs on has no screen ("Your Browser"). */
  openYourBrowserTab(pip: { id: string; name: string } | null): void {
    const key = pip ? pip.id : 'own';
    const open = this.browserTabs.get(key);
    if (open) { open.panel.reveal(pip ? vscode.ViewColumn.Beside : open.panel.viewColumn); return; }
    const title = pip ? `${pip.name} · Your Browser` : 'Your Browser';
    const panel = vscode.window.createWebviewPanel('dgc.yourBrowser', title, pip ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [this.extensionUri],
    });
    try { panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icons', 'browser-halo', 'halo-64.png'); } catch { /* the plain tab */ }
    const surface = 'browser:' + key;
    this.browserTabs.set(key, { panel, pip });
    panel.onDidDispose(() => {
      this.browserTabs.delete(key);
      for (const [id, item] of this.pending) if (item.surface === surface) this.pending.delete(id);
      // Your own tab closed: DGC stops its stream and forgets its last picture.
      if (!pip && this.state.connected && this.apiVersion >= YOUR_BROWSER_API) {
        this.send({ type: 'pips_control', request: { type: 'use_your_browser_view', own: true, op: 'close', request_id: 'pips-browser-' + randomBytes(12).toString('hex') } }, this.backendIdentity);
      }
    });
    panel.webview.onDidReceiveMessage(message => this.receive(message, surface));
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', name)).toString();
    panel.webview.html = yourBrowserDocument(asset('yourBrowserTab.js'), asset('yourBrowserTab.css'), panel.webview.cspSource, title);
  }
  /** What a Pip's streamed tab asks: its own Pip's lane only (yourBrowserTabRefusal), sent as the Pips page's are. Your
   *  own tab's: your own tab only (yourOwnTabRefusal). */
  private receiveBrowserTab(message: any, surface: string): void {
    const tab = this.browserTabs.get(surface.slice(8));
    if (!tab) return;
    if (message?.type === 'pipsReady' || message?.type === 'pipsReconnect') {
      this.post(tab.pip ? { type: 'yourBrowserInit', pip: tab.pip } : { type: 'yourBrowserInit', own: true }, surface);
      this.post({ type: 'pipsConnection', generation: this.generation, apiVersion: this.apiVersion, ...this.state }, surface);
      return;
    }
    if (message?.type === 'pipsOpenYourBrowser') {
      // Another Pip's tab, from this tab's row of Pips: its own editor tab.
      const pip = chatPip(message.pip, false);
      if (pip && this.apiVersion >= YOUR_BROWSER_API) this.openYourBrowserTab({ id: pip.id, name: pip.name });
      return;
    }
    if (message?.type !== 'pipsRequest' || typeof message.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(message.id)) return;
    const fail = (text: string) => this.post({ type: 'pipsReply', id: message.id, ok: false, error: { message: text } }, surface);
    const refused = tab.pip ? yourBrowserTabRefusal(message.request, tab.pip.id) : yourOwnTabRefusal(message.request);
    if (refused) { fail(refused); return; }
    if (!this.state.connected || !this.state.supported || !this.state.enabled) { fail('Pips aren’t available. Update DGC, then reconnect.'); return; }
    if (this.apiVersion < YOUR_BROWSER_API) { fail(tab.pip ? 'Update DGC to watch a Pip’s tab in Your Browser.' : 'Update DGC to use Your Browser here.'); return; }
    for (const [id, item] of this.pending) if (Date.now() - item.at > 60000) this.pending.delete(id);
    // (Your own tab: a frame waited for, your input in order, and its size.)
    if ([...this.pending.values()].filter((item) => item.surface === surface).length >= (tab.pip ? 4 : 6)) { fail('Still waiting for the last picture.'); return; }
    const requestId = 'pips-browser-' + randomBytes(12).toString('hex');
    this.pending.set(requestId, { client: message.id, command: message.request.type, at: Date.now(), surface });
    if (!this.send({ type: 'pips_control', request: { ...message.request, request_id: requestId } }, this.backendIdentity)) { this.pending.delete(requestId); fail('DGC is not connected.'); }
  }
  /** A computer's own name, when its Pip has more than one and the tab is one of them. */
  private computerName(pipId: string, number?: number): string {
    const names = this.computerNames.get(pipId);
    if (!number) return '';
    return names && names.length > 1 ? names.find(n => n.number === number)?.name || `Computer ${number}` : names ? '' : `Computer ${number}`;
  }
  private computerTitle(pip: ComputerPip, number?: number): string { return `${pip.name} · ${this.computerName(pip.id, number) || 'Computer'}`; }
  /** DGC said a Pip's computers' names (a look, a rename, one more): its open tabs take their titles from them. */
  private computersNamed(pipId: unknown, value: unknown): void {
    const names = computerNameRows(value);
    if (typeof pipId !== 'string' || !names) return;
    const before = JSON.stringify(this.computerNames.get(pipId) || null);
    this.computerNames.set(pipId, names);
    if (JSON.stringify(names) === before) return;
    for (const [key, tab] of this.computers) {
      if (tab.pip.id !== pipId) continue;
      const title = this.computerTitle(tab.pip, tab.number);
      if (tab.panel.title !== title) tab.panel.title = title;
      this.post({ type: 'pipComputerNames', names }, 'computer:' + key);
    }
  }
  /** One copy command, sent by this host alone, answered with DGC's result or refused in DGC's own words. */
  private computerCopy(type: 'copy_pip_computer_file_in' | 'copy_pip_computer_file_out', fields: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.state.connected || !this.state.supported || !this.state.enabled) { reject(new Error('DGC is not connected. Nothing was copied.')); return; }
      const requestId = 'pips-copy-' + randomBytes(12).toString('hex');
      const end = (why: string) => { clearTimeout(timer); this.hostReads.delete(requestId); this.computerCopies.delete(end); reject(new Error(why)); };
      const timer = setTimeout(() => end('DGC didn’t answer in time. Look in Files to see whether it was copied.'), COMPUTER_COPY_WAIT_MS);
      (timer as any).unref?.();
      this.computerCopies.add(end);
      this.hostReads.set(requestId, (event) => {
        if (event.type === 'pips_result' && event.ok === true && event.command === type && event.result && typeof event.result === 'object') {
          clearTimeout(timer); this.hostReads.delete(requestId); this.computerCopies.delete(end); resolve(event.result); return;
        }
        const words = event.type === 'command_rejected' ? event.message : event.error?.message;
        end(typeof words === 'string' && words ? words.slice(0, 500) : 'DGC could not copy that file.');
      });
      if (!this.send({ type: 'pips_control', request: { ...fields, type, request_id: requestId } }, this.backendIdentity)) end('DGC is not connected. Nothing was copied.');
    });
  }
  /** A path on the computer running DGC, from a place the user picked in VS Code's own dialog ('' for one that is not a file there). */
  private pickedPath(uri: vscode.Uri | undefined): string {
    const path = uri && (uri.scheme === 'file' || uri.scheme === 'vscode-remote') ? uri.fsPath : '';
    return typeof path === 'string' ? path : '';
  }
  /** Add file… in a computer tab's Files (Pips API 87): the user picks files in VS Code's own dialog, and each is copied
   *  into the folder the tab is showing. The page says the folder in Files and nothing else; every path on this computer
   *  comes from the dialog. */
  private async addComputerFiles(surface: string, computer: { pip: ComputerPip }, message: any): Promise<void> {
    const done = (added: string[], errors: string[], extra: Record<string, unknown> = {}) => this.post({ type: 'pipComputerAdded', added, errors, ...extra }, surface);
    if (this.apiVersion < COMPUTER_COPY_API) { done([], ['Update DGC to add files over 2 MB.']); return; }
    if (!filesPath(message.folder)) { done([], ['Choose a folder in this computer’s Files.']); return; }
    if (this.computerCopying.has(surface)) return;
    this.computerCopying.add(surface);
    const added: string[] = [], errors: string[] = [];
    try {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false, openLabel: 'Add', title: `Add files to ${computer.pip.name}’s computer` });
      if (!picked?.length) { done([], [], { cancelled: true }); return; }
      const files = picked.map(uri => { const path = this.pickedPath(uri); return { path, name: (path || uri.path).split(/[\\/]/).pop() || 'file' }; });
      for (const [index, file] of files.entries()) {
        this.post({ type: 'pipComputerAdding', names: files.slice(index).map(f => f.name), ...(index ? { refresh: true } : {}) }, surface);
        if (!file.path) { errors.push(`${file.name}: choose a file on the computer running DGC.`); continue; }
        try {
          const result = await this.computerCopy('copy_pip_computer_file_in', { pip_id: computer.pip.id, path: message.folder, source: file.path });
          added.push(typeof result.name === 'string' && result.name ? result.name.slice(0, 255) : file.name);
        } catch (error) { errors.push(error instanceof Error && error.message ? error.message : 'DGC could not copy that file.'); }
      }
      done(added, errors);
    } catch (error) {
      done(added, [...errors, error instanceof Error && error.message ? error.message : 'DGC could not add those files.']);
    } finally { this.computerCopying.delete(surface); }
  }
  /** Download on a file in a computer tab's Files (Pips API 87): DGC copies it out into a private folder made for this
   *  download, and the page saves it on the person's own computer (src/download.ts; one too large for a page goes to
   *  their browser). The page says which file in Files and nothing else. */
  private async saveComputerFileAs(surface: string, computer: { pip: ComputerPip }, message: any): Promise<void> {
    const done = (ok: boolean, extra: Record<string, unknown> = {}) => this.post({ type: 'pipComputerSavedAs', ok, ...extra }, surface);
    if (this.apiVersion < COMPUTER_COPY_API) { done(false, { error: 'Update DGC to save files over 2 MB.' }); return; }
    if (!filesPath(message.path) || !message.path) { done(false, { error: 'Choose a file in this computer’s Files.' }); return; }
    if (this.computerCopying.has(surface)) return;
    this.computerCopying.add(surface);
    try {
      const last = message.path.split('/').pop() || '', name = /^[^/\\\0]{1,255}$/.test(last) ? last : 'file';
      const sent = await downloadMade((m) => this.post(m, surface), name, async (target) => {
        const result = await this.computerCopy('copy_pip_computer_file_out', { pip_id: computer.pip.id, path: message.path, target: this.pickedPath(vscode.Uri.file(target)) || target });
        return typeof result.target === 'string' && result.target ? result.target : target;
      });
      done(sent, sent ? { name, downloaded: true } : { error: 'Not downloaded.' });
    } catch (error) {
      done(false, { error: error instanceof Error && error.message ? error.message : 'Not saved.' });
    } finally { this.computerCopying.delete(surface); }
  }
  /** Download a small file from a Pip's computer, from the bytes its own read gave the page (src/download.ts). */
  private async saveComputerFile(surface: string, message: any): Promise<void> {
    const name = typeof message.name === 'string' && /^[^/\\\0]{1,255}$/.test(message.name) ? message.name : 'file';
    try {
      const maximum = 2 * 1024 * 1024;
      let data: Buffer | undefined;
      if (typeof message.data === 'string') {
        const match = /^data:[^;,]{1,200};base64,([A-Za-z0-9+/]*={0,2})$/.exec(message.data);
        if (!match || decodedBytes(match[1]) > maximum) throw Error('Nothing to save.');
        data = Buffer.from(match[1], 'base64');
        if (data.toString('base64') !== match[1]) throw Error('Nothing to save.');
      } else if (typeof message.text === 'string' && Buffer.byteLength(message.text, 'utf8') <= maximum) {
        data = Buffer.from(message.text, 'utf8');
      }
      if (!data || data.byteLength > 2 * 1024 * 1024) throw Error('Nothing to save.');
      const sent = await downloadBytes((m) => this.post(m, surface), name, data);
      this.post(sent ? { type: 'pipComputerSaved', ok: true, name, downloaded: true } : { type: 'pipComputerSaved', ok: false, error: 'Not downloaded.' }, surface);
    } catch (error) {
      this.post({ type: 'pipComputerSaved', ok: false, error: error instanceof Error ? error.message : 'Not saved.' }, surface);
    }
  }
  open(navigation?: { pip: string; section?: 'chat' | 'runs'; run?: string } | { overview: true }): void {
    this.embeddedPost = undefined;
    this.panelNavigation = navigation;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.connect();
      if (navigation) this.post({ type: 'pipsNavigate', navigation });
      return;
    }
    const panel = vscode.window.createWebviewPanel('dgc.pips', 'DGC Pips', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri],
    });
    this.panel = panel;
    // (Its own requests go with it; a chat's tab on this bridge keeps the ones it is waiting on.)
    panel.onDidDispose(() => { this.panel = undefined; for (const [id, item] of this.pending) if (!item.surface || item.surface === 'main') this.pending.delete(id); this.dictation?.().release(this.mic); this.readAloud?.().release(this.mic); });
    // (focused: this window has the focus. A Pip's chat reads what it shows only while someone can be looking at it;
    // when the focus is back with its tab in front, it reads it then. "New" means not seen, 13 Nov.)
    const focused = () => { try { return vscode.window.state?.focused !== false; } catch { return true; } };
    panel.onDidChangeViewState(() => panel.webview.postMessage({ type: 'pipsVisibility', visible: panel.visible, focused: focused() }));
    try { const watch = vscode.window.onDidChangeWindowState?.(() => { void panel.webview.postMessage({ type: 'pipsVisibility', visible: panel.visible, focused: focused() }); }); if (watch) panel.onDidDispose(() => watch.dispose()); } catch { /* an editor that does not say */ }
    panel.webview.onDidReceiveMessage(message => this.receive(message));
    panel.webview.html = this.pageHtml(panel);
    this.connect();
  }
  ready(capabilities: any, backendIdentity?: object): void {
    if (this.state.connected && backendIdentity && backendIdentity === this.backendIdentity) return;
    this.backendIdentity = backendIdentity;
    this.backgroundSetup = capabilities?.pips_setup_notifications === 1;
    this.apiVersion = Number.isSafeInteger(capabilities?.pips_api_version) ? capabilities.pips_api_version : 0;
    this.displayMentions = capabilities?.pip_display_mentions === 1;
    this.desktopStream = capabilities?.pips_desktop === 1;
    this.desktopNumbers = this.desktopStream && capabilities?.pips_desktop_numbers === 1 && this.apiVersion >= 86;
    this.desktopOwner.clear();
    this.learn = Number(capabilities?.learn?.version) >= 1;
    this.foldersOn = foldersOffered(capabilities);
    this.listedFolders.clear();
    this.spoolDir = capabilities?.image_spool === true && typeof capabilities?.image_spool_dir === 'string' ? capabilities.image_spool_dir : '';
    this.generation++;
    this.pending.clear();
    this.endComputerCopies();
    this.connectFailed = false;
    this.state = { connected: true, supported: capabilities?.pips_supported === true && capabilities?.pips_api_version >= 9, enabled: capabilities?.pips_enabled === true };
    this.publish();
    try { this.whenReady?.(); } catch { /* the welcome is never in the way of the connection */ }
  }
  /** Told each time a DGC is connected (the panel offers the Pips tab's one-time welcome once DGC can be asked). */
  private whenReady?: () => void;
  useReady(notify: () => void): void { this.whenReady = notify; }
  /** A DGC with the Pips flow is connected (Pips API 96): a Pip tells you in its own chat, and get_pips_welcome answers. */
  flowReady(): boolean { return this.state.connected && this.state.supported && this.state.enabled && this.apiVersion >= FLOW_API; }
  /** get_pips_welcome {} (Pips API 96): what the Pips tab's one-time welcome names. An older DGC is never asked. */
  welcome(): Promise<any> {
    if (!this.flowReady()) return Promise.reject(new Error('Update DGC to see how Pips work now.'));
    return this.hostAsk('get_pips_welcome');
  }
  /** `failed`: the backend stopped and isn't coming back by itself, so the page says so. Any other time with no connection
   *  (starting, a chat switching, a restart under way) the page only waits. */
  offline(failed = false): void {
    if (!this.state.connected && failed === this.connectFailed) return;
    this.generation++; this.pending.clear(); this.endComputerCopies(); this.state.connected = false; this.connectFailed = failed; this.publish();
  }
  /** The connection to DGC changed: a copy it was making is not waited for any longer. */
  private endComputerCopies(): void { for (const end of [...this.computerCopies]) end('The connection to DGC changed. Look in Files to see whether it was copied.'); }
  private publish(): void {
    // Whether a folder is open in this window: with none, the Pips view's Project tab says to open one rather than show
    // the Pips of wherever DGC happened to start. Left out where the editor doesn't say.
    const folder = vscode.workspace ? (vscode.workspace.workspaceFolders?.length ?? 0) > 0 : undefined;
    // The Project Folder dropdown (Pips API 93): what is chosen, the home folder (a path shows it as ~) and this
    // window's folder (Create a Project Pip opens on it). Left out for a DGC that lists no folders.
    const own = vscode.workspace?.workspaceFolders?.[0]?.uri?.fsPath;
    const folders = this.foldersOn && this.projectFolderHook
      ? { projectFolder: this.projectFolderHook.choice(), home: homedir(), ...(typeof own === 'string' && own ? { windowFolder: { folder: own, name: own.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || own } } : {}) } : {};
    const connection = { type: 'pipsConnection', generation: this.generation, apiVersion: this.apiVersion, backgroundSetup:this.backgroundSetup, displayMentions:this.displayMentions, ...(folder === undefined ? {} : { folder }), ...folders, ...(this.connectFailed ? { failed: true } : {}), ...this.state };
    this.postPages(connection);
    for (const id of this.computers.keys()) this.post(connection, 'computer:' + id);
    for (const id of this.browserTabs.keys()) this.post(connection, 'browser:' + id);
  }
  /** One host-owned read through the same channel: only the digest, only on an API 41 backend. */
  hostRead(type: 'get_pip_digest' | 'list_pip_attention', fields: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.state.connected || !this.state.supported || !this.state.enabled || this.apiVersion < (type === 'list_pip_attention' ? 44 : 41)) { reject(new Error('Pips are unavailable.')); return; }
      const requestId = 'pips-host-' + randomBytes(12).toString('hex');
      const timer = setTimeout(() => { this.hostReads.delete(requestId); reject(new Error('No reply from DGC.')); }, 20000);
      this.hostReads.set(requestId, (event) => {
        clearTimeout(timer); this.hostReads.delete(requestId);
        if (event.type === 'pips_result' && event.ok === true && event.command === type) resolve(event.result); else reject(new Error('DGC could not read Pips.'));
      });
      if (!this.send({ type: 'pips_control', request: { ...fields, type, request_id: requestId } }, this.backendIdentity)) {
        clearTimeout(timer); this.hostReads.delete(requestId); reject(new Error('DGC is not connected.'));
      }
    });
  }
  /** get_pip_runner's runner.boxes (Pips API 96): whether this machine gives Pips their own computer, as DGC says it.
   *  The Mac dialog's cue (src/pipsWelcome.ts). An older DGC is never asked. */
  async boxes(): Promise<any> {
    if (!this.flowReady()) throw new Error('Update DGC to see whether Pips have their own computers here.');
    return (await this.hostAsk('get_pip_runner'))?.runner?.boxes;
  }
  /** The folders with a Work session or a Project Pip (list_project_folders, Pips API 93), for the Project Folder
   *  dropdown. An older DGC is never asked. */
  projectFolders(): Promise<any> {
    if (this.apiVersion < FOLDERS_API) return Promise.reject(new Error('Update DGC to choose a project folder.'));
    return this.hostAsk('list_project_folders');
  }
  /** A job a chat handed a Pip (Pips API 111), for a job's card in a page with no Pips channel of its own (a ChatDGC tab):
   *  only the commands a job's card sends, on a DGC that has jobs. */
  pipJob(type: string, fields: Record<string, unknown>): Promise<any> {
    const allowed = ['get_pip_job', 'start_pip_job', 'decline_pip_job', 'get_pip_project_change', 'apply_pip_project_change',
      'discard_pip_project_change', 'undo_pip_project_change'] as const;
    if (!(allowed as readonly string[]).includes(type)) return Promise.reject(new Error('A job’s card can’t ask that.'));
    if (this.apiVersion < PIP_JOBS_API) return Promise.reject(new Error('Update DGC to follow a Pip’s job here.'));
    { const refused = pipJobsRefusal({ ...fields, type }, this.apiVersion); if (refused) return Promise.reject(new Error(refused)); }
    return this.hostAsk(type as typeof allowed[number], fields);
  }
  /** One read the host makes for Continue in Work, answered in DGC's own words when it is refused. */
  private hostAsk(type: 'get_pips_welcome' | 'get_pip_runner' | 'list_project_folders' | 'add_project_folder' | 'list_workspaces' | 'get_pip_project_change' | 'get_pip' | 'list_session_pips' | 'set_pip_owner' | 'archive_pip' | 'delete_archived_pip' | 'list_related_pips' | 'list_pips' | 'cancel_pip_run'
    | 'get_pip_job' | 'start_pip_job' | 'decline_pip_job' | 'apply_pip_project_change' | 'discard_pip_project_change' | 'undo_pip_project_change', fields: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.state.connected || !this.state.supported || !this.state.enabled) { reject(new Error('Pips aren’t available. Reconnect, then try again.')); return; }
      const requestId = 'pips-host-' + randomBytes(12).toString('hex');
      const timer = setTimeout(() => { this.hostReads.delete(requestId); reject(new Error('DGC didn’t answer in time. Try again.')); }, 30000);
      (timer as any).unref?.();
      this.hostReads.set(requestId, (event) => {
        clearTimeout(timer); this.hostReads.delete(requestId);
        if (event.type === 'pips_result' && event.ok === true && event.command === type) resolve(event.result);
        else reject(new Error(typeof event.error?.message === 'string' && event.error.message ? event.error.message : typeof event.message === 'string' && event.message ? event.message : 'DGC couldn’t read that. Try again.'));
      });
      if (!this.send({ type: 'pips_control', request: { ...fields, type, request_id: requestId } }, this.backendIdentity)) {
        clearTimeout(timer); this.hostReads.delete(requestId); reject(new Error('DGC is not connected.'));
      }
    });
  }
  /** Continue in Work, from the card of what a Pip changed in its copy of a project. The page names the Pip and the
   *  change, nothing else: the project, its files and the patch are read from DGC here. Work opens only in the folder
   *  this window has open, so only for that project: DGC tells the editor no other project's folder. Nothing about the
   *  change is decided: it still waits in the Pip's chat. */
  private async openProjectWork(request: any): Promise<void> {
    const open = this.projectWork;
    if (!open) throw new Error('Work can’t be opened from here. Open DGC’s side bar, then choose Continue in Work again.');
    const generation = this.generation;
    const here = await this.hostAsk('list_workspaces');
    const read = await this.hostAsk('get_pip_project_change', { pip_id: request.pip_id, change_id: request.change_id });
    const change = projectChange(read);
    if (change.id !== request.change_id) throw new Error('DGC answered about another change. Open the chat again.');
    if (typeof here?.current_workspace_id !== 'string' || here.current_workspace_id !== change.workspace_id) {
      throw new Error(`Work opens in the folder this window has open. Open ${change.name} in VS Code, then choose Continue in Work there.`);
    }
    if (change.status !== 'pending') throw new Error('This change was decided already.');
    const patch = read?.patch;
    if (typeof patch !== 'string' || !patch.trim()) throw new Error('There is nothing to carry over: this change has no text to put in a patch.');
    let pipName = '';
    try { const got = await this.hostAsk('get_pip', { pip_id: request.pip_id }); if (typeof got?.pip?.name === 'string') pipName = got.pip.name.slice(0, 120); } catch { /* the first message says "A Pip" */ }
    if (generation !== this.generation || !this.state.connected) throw new Error('The DGC connection changed. Choose Continue in Work again.');
    const file = patchFileName(change);
    const opened = await open({ name: change.name, change_id: change.id, file, patch, brief: projectWorkBrief(change, { pipName, file, cut: read?.patch_cut === true }) });
    if (!opened) throw new Error('Work didn’t open. Choose Continue in Work again when you’re ready.');
  }
  /** A Pip's report card in a Work chat acted on (Dismiss, Fix): that run's post counts as read for its Pip. Only on Pips
   *  API 69, which keeps unread; DGC refuses a run with no post in that Pip's chat, and nothing changes. */
  markRunRead(pipId: string, runId: string): void {
    if (!this.state.connected || !this.state.supported || !this.state.enabled || this.apiVersion < 69) return;
    if (!/^pip_[0-9a-f]{32}$/.test(pipId) || !/^run_[0-9a-f]{32}$/.test(runId)) return;
    const requestId = 'pips-host-' + randomBytes(12).toString('hex');
    const timer = setTimeout(() => this.hostReads.delete(requestId), 20000);
    (timer as any).unref?.();
    this.hostReads.set(requestId, (event) => {
      clearTimeout(timer); this.hostReads.delete(requestId);
      if (event.type === 'pips_result' && event.ok === true && event.command === 'mark_pip_read') this.unreadRead?.();
    });
    if (!this.send({ type: 'pips_control', request: { type: 'mark_pip_read', pip_id: pipId, post_id: runId, request_id: requestId } }, this.backendIdentity)) {
      clearTimeout(timer); this.hostReads.delete(requestId);
    }
  }
  event(event: any): boolean {
    // The folders DGC lists are the ones the dropdown offers: one of them may be chosen, or added as a project.
    if (event?.type === 'pips_result' && event.ok === true && event.command === 'list_project_folders' && Array.isArray(event.result?.folders)) {
      this.listedFolders.clear();
      for (const row of event.result.folders.slice(0, 200)) { const folder = fullFolder(row?.folder); if (folder) this.listedFolders.add(folder); }
    }
    if ((event.type === 'skill_draft' || event.type === 'skill_saved') && this.pending.has(event.request_id)) {
      // A Pip chat's /learn: the draft (or where Save put it) goes back to the page that asked.
      const owner = this.pending.get(event.request_id)!;
      this.pending.delete(event.request_id);
      this.post({ type: 'pipsReply', id: owner.client, ok: event.ok === true, result: event,
        error: event.ok === true ? undefined : { message: String(event.message || 'DGC couldn’t do that.') } }, owner.surface);
      return true;
    }
    if (event.type === 'pip_desktop_data' || event.type === 'pip_desktop_closed') {
      // The screen goes only to the tab showing that Pip's computer: the one that opened its stream last.
      const key = typeof event.pip_id === 'string' ? this.desktopOwner.get(event.pip_id) ?? event.pip_id : undefined;
      const tab = key !== undefined ? this.computers.get(key) : undefined;
      if (tab && tab.pip.id === event.pip_id) this.post(event.type === 'pip_desktop_data' ? { type: 'pipDesktopData', data: event.data } : { type: 'pipDesktopClosed', reason: String(event.reason || '') }, 'computer:' + key);
      if (event.type === 'pip_desktop_closed' && typeof event.pip_id === 'string') this.desktopOwner.delete(event.pip_id);
      return true;
    }
    if (!['pips_result', 'pips_status'].includes(event.type) && !(event.type === 'command_rejected' && ['pips_control', 'pips_enable', 'pips_runtime'].includes(event.command))) return false;
    const hostRead = this.hostReads.get(event.request_id);
    if (hostRead) { hostRead(event); return true; }
    const owner = this.pending.get(event.request_id);
    if (!owner) return true;
    if (event.type === 'pips_result' && event.command !== owner.command) return true;
    this.pending.delete(event.request_id);
    if (owner.document && event.type === 'pips_result' && event.ok === true) {
      void this.openResultDocument(owner.client, owner.document, event.result?.run, owner.surface);
      return true;
    }
    if (owner.exportFile && event.type === 'pips_result' && event.ok === true) {
      void this.openExport(owner.client, owner.exportFile.generation, event.result, owner.surface);
      return true;
    }
    if (owner.exportTeam && event.type === 'pips_result' && event.ok === true) {
      void this.saveTeam(owner.client, owner.exportTeam.generation, event.result, owner.surface);
      return true;
    }
    if (owner.spooled && !(event.type === 'pips_result' && event.ok === true)) void this.unspool(owner.spooled);
    if (owner.keptImage && event.type === 'pips_result' && event.ok === true) {
      void this.keptImage(event.result, owner.keptImage).then(
        image => this.post({ type: 'pipsReply', id: owner.client, ok: true, result: { pip_id: owner.keptImage!.pip, message_id: owner.keptImage!.message, index: owner.keptImage!.index, image } }, owner.surface),
        error => this.post({ type: 'pipsReply', id: owner.client, ok: false, error: { message: error instanceof Error ? error.message : 'That photo could not be read.' } }, owner.surface));
      return true;
    }
    if (owner.command === 'start_pip_app_link' && event.type === 'pips_result' && event.ok === true) {
      void this.openSignIn(owner.client, event.result, owner.surface);
      return true;
    }
    if (owner.command === 'list_pip_models' && event.type === 'pips_result' && event.ok === true && this.savedProviders) {
      void Promise.all([this.savedProviders.list().catch(() => [] as unknown[]), this.planHooks?.offer().catch(() => '') ?? Promise.resolve('')]).then(([providers, planOffer]) =>
        this.post({ type: 'pipsReply', id: owner.client, ok: true, result: { ...event.result, providers, ...(planOffer ? { plan_offer: planOffer } : {}), ...(this.savedProviders?.host() ? { host: this.savedProviders.host() } : {}), ...(this.savedProviders?.none() ? { no_provider: true } : {}) } }, owner.surface));
      return true;
    }
    if (event.type === 'pips_status') this.state.enabled = event.enabled === true;
    if (owner.newsDismiss && event.type === 'pips_result' && event.ok === true) {
      this.newsDismissed?.(owner.newsDismiss.pipIds, owner.newsDismiss.until);
    }
    if (event.type === 'pips_result' && event.ok === true && this.apiVersion >= 86) {
      // A Pip's computers by name: its open tabs are titled from what DGC says, never from what a page says.
      if (owner.command === 'get_pip_computer') this.computersNamed(event.result?.computer?.pip_id, event.result?.computer?.names);
      else if (owner.command === 'rename_pip_computer' || owner.command === 'add_pip_computer') this.computersNamed(event.result?.pip_id, event.result?.names);
    }
    if (owner.command === 'mark_pip_read' && event.type === 'pips_result' && event.ok === true) this.unreadRead?.();
    // A message DGC took from one page: every other page showing that Pip's chat reads it again (the same chat, in its
    // editor tab, in the Pips page, in the side bar).
    if (['send_pip_message', 'answer_pip_questions'].includes(owner.command) && event.type === 'pips_result' && event.ok === true && owner.pip) this.tellOthers({ type: 'pipsChatChanged', pip_id: owner.pip }, owner.surface || 'main');
    if (owner.command === 'set_pip_profile' && event.type === 'pips_result' && event.ok === true) this.profileChangeNotice?.();
    // A Pip's face on its chat tabs follows DGC's own word for its character: its page read, or its character changed.
    if (event.type === 'pips_result' && event.ok === true) {
      if (owner.command === 'get_pip' && event.result?.pip && typeof event.result.pip === 'object') PipsEditor.faceSaid(event.result.pip.id, event.result.pip.profile);
      else if (owner.command === 'set_pip_profile' && event.result && typeof event.result === 'object' && 'profile' in event.result) PipsEditor.faceSaid(event.result.pip_id, event.result.profile);
    }
    if ((owner.command === 'accept_pip_setup' || owner.command === 'reject_pip_setup') && event.type === 'pips_result' && event.ok === true) {
      const decided = event.result?.setup?.id;
      if (typeof decided === 'string' && /^setup_[a-f0-9]{32}$/.test(decided)) this.setupDecided?.(decided);
    }
    this.post({ type: 'pipsReply', id: owner.client,
      ok: event.type !== 'command_rejected' && (event.type === 'pips_status' || event.ok === true),
      result: event.type === 'pips_status' ? event : event.result,
      error: event.type === 'command_rejected' ? {message: event.message} : event.error }, owner.surface);
    return true;
  }
  /** Connect on a Pip's app card: the sign-in link comes from the correlated backend reply, never from the
   *  webview, and the host opens it; the webview learns only that it opened and on which site. */
  private async openSignIn(client: string, result: any, surface?: string): Promise<void> {
    const url = typeof result?.redirect_url === 'string' ? result.redirect_url : '';
    let opened = false;
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && url.length <= 4096 && !/[\u0000-\u001f\s]/.test(url)) {
          opened = await vscode.env.openExternal(vscode.Uri.parse(parsed.href, true));
        }
      } catch { opened = false; }
    }
    const { redirect_url: _link, ...rest } = result || {};
    this.post({ type: 'pipsReply', id: client, ok: true, result: { ...rest, opened } }, surface);
  }
  /** A shared Pip file opens as an unsaved JSON document, then Save As: the user picks where. */
  private async openExport(client: string, generation: number, result: any, surface?: string): Promise<void> {
    try {
      if (generation !== this.generation || !this.state.connected) throw Error('The DGC connection changed. Export again.');
      const text = result?.text;
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 24576) throw Error('The shared Pip file is invalid.');
      const document = await vscode.workspace.openTextDocument({ language: 'json', content: text });
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
      await vscode.commands.executeCommand('workbench.action.files.saveAs', document.uri);
      const leftOut = Array.isArray(result?.document?.left_out) ? result.document.left_out.filter((x: any) => typeof x === 'string').slice(0, 8) : [];
      this.post({ type: 'pipsReply', id: client, ok: true, result: { opened: true, left_out: leftOut } }, surface);
    } catch (error) {
      this.post({ type: 'pipsReply', id: client, ok: false, error: { message: error instanceof Error ? error.message : 'Could not export the Pip.' } }, surface);
    }
  }
  /** The user picks a shared Pip file; the host reads it and the chat saves it as a setup card. */
  private async importFile(client: string, surface?: string): Promise<void> {
    const fail = (text: string) => this.post({ type: 'pipsReply', id: client, ok: false, error: { message: text } }, surface);
    try {
      const generation = this.generation;
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Import Pip', filters: { 'Shared Pip': ['json'] } });
      if (!picked || !picked.length) { this.post({ type: 'pipsReply', id: client, ok: true, result: { cancelled: true } }, surface); return; }
      const bytes = await vscode.workspace.fs.readFile(picked[0]);
      if (bytes.byteLength > 24576) { fail('A shared Pip file is at most 24 KiB.'); return; }
      if (generation !== this.generation || !this.state.connected) { fail('The DGC connection changed. Import again.'); return; }
      const requestId = 'pips-editor-' + randomBytes(12).toString('hex');
      this.pending.set(requestId, { client, command: 'import_pip_document', at: Date.now(), surface });
      if (!this.send({ type: 'pips_control', request: { type: 'import_pip_document', document: Buffer.from(bytes).toString('utf8'), request_id: requestId } }, this.backendIdentity)) {
        this.pending.delete(requestId); fail('DGC could not send the file. Nothing was saved.');
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Could not read the shared Pip file.');
    }
  }
  /** pips-12: a team's file, downloaded by the page on the person's own computer. The text came from DGC's own export;
   *  the page hears the file's name and what was left out. */
  private async saveTeam(client: string, generation: number, result: any, surface?: string): Promise<void> {
    try {
      if (generation !== this.generation || !this.state.connected) throw Error('The DGC connection changed. Export again.');
      const text = result?.text, team = result?.document;
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > TEAM_FILE_BYTES || team?.format !== 'dgc-team' || typeof team.name !== 'string'
        || !Array.isArray(team.pips) || !team.pips.length || team.pips.length > TEAM_PIPS) throw Error('The team file is invalid.');
      // A download to the person's own computer, from the page that asked (src/download.ts): the dialog stays only where
      // the place is the project (his call, 18 Nov).
      const file = teamFileName(team.name);
      if (!await downloadBytes((m) => this.post(m, surface), file, Buffer.from(text, 'utf8'), 'application/json')) throw Error('The team file could not be handed to this page.');
      const leftOut: string[] = [];
      for (const pip of team.pips) for (const note of Array.isArray(pip?.left_out) ? pip.left_out : []) if (typeof note === 'string' && !leftOut.includes(note)) leftOut.push(note);
      this.post({ type: 'pipsReply', id: client, ok: true, result: { saved: true, file, name: team.name, count: team.pips.length, left_out: leftOut.slice(0, 8) } }, surface);
    } catch (error) {
      this.post({ type: 'pipsReply', id: client, ok: false, error: { message: error instanceof Error ? error.message : 'Could not export the team.' } }, surface);
    }
  }
  /** pips-12: the user picks a team file; the host reads it and the chat saves one setup card per Pip in it. */
  private async importTeamFile(client: string, surface?: string): Promise<void> {
    const fail = (text: string) => this.post({ type: 'pipsReply', id: client, ok: false, error: { message: text } }, surface);
    try {
      const generation = this.generation;
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Import team', filters: { 'DGC team': ['json'] } });
      if (!picked || !picked.length) { this.post({ type: 'pipsReply', id: client, ok: true, result: { cancelled: true } }, surface); return; }
      const bytes = await vscode.workspace.fs.readFile(picked[0]);
      if (bytes.byteLength > TEAM_FILE_BYTES) { fail('A team file is at most 256 KiB.'); return; }
      if (generation !== this.generation || !this.state.connected) { fail('The DGC connection changed. Import again.'); return; }
      const requestId = 'pips-editor-' + randomBytes(12).toString('hex');
      this.pending.set(requestId, { client, command: 'import_pip_team', at: Date.now(), surface });
      if (!this.send({ type: 'pips_control', request: { type: 'import_pip_team', document: Buffer.from(bytes).toString('utf8'), request_id: requestId } }, this.backendIdentity)) {
        this.pending.delete(requestId); fail('DGC could not send the file. Nothing was saved.');
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Could not read the team file.');
    }
  }
  private async openResultDocument(client: string, requested: { run: string; save: boolean; generation: number }, run: any, surface?: string): Promise<void> {
    try {
      if (requested.generation !== this.generation || !this.state.connected) throw Error('The DGC connection changed. Open the result again.');
      if (run?.id !== requested.run || run?.status !== 'succeeded') throw Error('Only a completed saved result can be opened.');
      const kind = run.manifest?.run_kind;
      const text = kind === 'personal_task' ? run.result?.text : kind === 'draft' ? run.result?.draft?.markdown : undefined;
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 131072) throw Error('This run has no supported Markdown document within the 128 KiB limit.');
      // Text comes from the correlated backend read, never from a webview payload.
      // Open source text, not a preview that could load model-authored image URLs.
      const content = `Saved Pip result · ${requested.run}\n\nWritten by a Pip with its model. Check it before you rely on it or share it.\n\n${text}\n`;
      const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
      if (requested.generation !== this.generation || !this.state.connected) throw Error('The DGC connection changed. Open the result again.');
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
      if (requested.save) await vscode.commands.executeCommand('workbench.action.files.saveAs', document.uri);
      this.post({type:'pipsReply', id:client, ok:true, result:{opened:true}}, surface);
    } catch (error) {
      this.post({type:'pipsReply', id:client, ok:false, error:{message:error instanceof Error ? error.message : 'Could not open the saved document.'}}, surface);
    }
  }
  /** A kept photo the backend named (get_pip_message_image as_file, API 52), read here as a data URI: a photo
   *  of 8 MiB is more than any protocol frame carries. Only a regular file where the backend keeps a Pip
   *  chat's photos, named by its digest, of the size and type it said. */
  private async keptImage(result: any, want: { pip: string; message: string; index: number; generation: number }): Promise<string> {
    const fs = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const gone = () => new Error('That photo is no longer available.');
    if (want.generation !== this.generation || !this.state.connected) throw new Error('The DGC connection changed. Refresh and try again.');
    const path = result?.path, bytes = result?.bytes;
    if (result?.message_id !== want.message || result?.index !== want.index || typeof path !== 'string' || !nodePath.isAbsolute(path)
      || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > RAISED_LIMITS.photo) throw gone();
    const info = await fs.lstat(path).catch(() => undefined);
    if (!info || !info.isFile() || info.isSymbolicLink() || info.size !== bytes) throw gone();
    const real = await fs.realpath(path);
    const name = nodePath.basename(real), kind = KEPT_PHOTO.exec(name)?.[1];
    if (!kind || KEPT_MIME[kind] !== result.mime || nodePath.basename(nodePath.dirname(real)) !== want.pip
      || nodePath.basename(nodePath.dirname(nodePath.dirname(real))) !== 'chat_images') throw gone();
    const raw = await fs.readFile(real);
    const magic = kind === 'png' ? raw.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : kind === 'jpg' ? raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff
      : kind === 'gif' ? ['GIF87a', 'GIF89a'].includes(raw.subarray(0, 6).toString('latin1'))
      : kind === 'webp' ? raw.subarray(0, 4).toString('latin1') === 'RIFF' && raw.subarray(8, 12).toString('latin1') === 'WEBP'
      : raw.subarray(0, 2).toString('latin1') === 'BM';
    if (!magic || raw.byteLength !== bytes) throw gone();
    return `data:${result.mime};base64,${raw.toString('base64')}`;
  }
  /** The spool files of a send that never reached the backend, or that it refused before reading. */
  private async unspool(names: string[]): Promise<void> {
    if (!this.spoolDir) return;
    const fs = await import('node:fs/promises');
    const nodePath = await import('node:path');
    await Promise.all(names.map(name => fs.unlink(nodePath.join(this.spoolDir, name)).catch(() => undefined)));
  }
  /** What is wrong with a message's photos and files for the spool (API 52), or '' when they fit. */
  private spoolProblem(images: unknown, files: unknown): string {
    let carried = 0;                 // photos and files together (API 79: 200 MB a message)
    if (images !== undefined) {
      if (!Array.isArray(images) || images.length < 1 || images.length > MAX_SPOOLED_PHOTOS) return `Send up to ${MAX_SPOOLED_PHOTOS} photos with one message.`;
      let total = 0;
      const L = this.apiVersion >= 79 ? RAISED_LIMITS : OLD_LIMITS;
      for (const image of images) {
        const match = typeof image === 'string' ? DATA_URI.exec(image) : null;
        if (!match || !SPOOL_PHOTO_TYPES[match[1].toLowerCase()]) return 'Send photos as PNG, JPEG, GIF, WebP, BMP or iPhone (HEIC) images.';
        const size = decodedBytes(match[2]);
        if (size < 1 || size > L.photo || (total += size) > L.photos) return photoLimits(L);
        carried += size;
      }
    }
    if (files !== undefined) {
      const L = this.apiVersion >= 79 ? RAISED_LIMITS : OLD_LIMITS;
      if (!Array.isArray(files) || files.length < 1 || files.length > L.files) return fileLimits(L);
      let total = 0;
      for (const f of files as any[]) {
        if (!f || typeof f !== 'object' || Object.keys(f).sort().join() !== 'data,name' || typeof f.name !== 'string' || !f.name.trim()
          || f.name.length > 255 || /[\/\\"\u0000-\u001f]/.test(f.name)) return 'Name each file plainly: no folders, quotes or control characters.';
        const match = typeof f.data === 'string' ? DATA_URI.exec(f.data) : null;
        const dot = f.name.lastIndexOf('.'), ext = dot > 0 ? f.name.slice(dot).toLowerCase() : '';
        const size = match ? decodedBytes(match[2]) : 0;
        if (!match || size < 1 || size > (DOCUMENT_EXTENSIONS.has(ext) ? L.document : MAX_TEXT_FILE_BYTES) || (total += size) > L.filesBytes) return fileLimits(L);
        carried += size;
        if (carried > L.message) return `Send up to ${mb(L.message)} of photos and files with one message.`;
      }
    }
    return '';
  }
  /** Send a Pip message whose photos and files go through the spool (API 52): each written, readable only by
   *  you, under a fresh name in the backend's own spool, then sent by name. A spool the host can't write falls
   *  back to the inline path when the message fits it (four images, 2 MB, no iPhone photos). */
  private async sendSpooled(client: string, surface: string, request: any, requestId: string): Promise<void> {
    const fail = (text: string) => this.post({ type: 'pipsReply', id: client, ok: false, error: { message: text } }, surface);
    const generation = this.generation, written: string[] = [];
    const spooledImages: { name: string; media_type: string }[] = [], spooledFiles: { name: string; spool: string }[] = [];
    try {
      const fs = await import('node:fs/promises');
      const nodePath = await import('node:path');
      await fs.mkdir(this.spoolDir, { recursive: true, mode: 0o700 });
      const put = async (b64: string, ext: string) => {
        const name = `${randomBytes(16).toString('hex')}.${ext}`;
        await fs.writeFile(nodePath.join(this.spoolDir, name), Buffer.from(b64, 'base64'), { mode: 0o600, flag: 'wx' });
        written.push(name);
        return name;
      };
      for (const image of request.images || []) {
        const [, mime, b64] = DATA_URI.exec(image)!;
        spooledImages.push({ name: await put(b64, SPOOL_PHOTO_TYPES[mime.toLowerCase()]), media_type: mime.toLowerCase() });
      }
      for (const f of request.files || []) spooledFiles.push({ name: f.name, spool: await put(DATA_URI.exec(f.data)![2], 'bin') });
    } catch {
      await this.unspool(written);
      const images: string[] = request.images || [], files: any[] = request.files || [];
      const inline = images.length <= 4 && files.length <= 4 && images.every(i => !/^data:image\/hei[cf];/i.test(i))
        && images.reduce((n, i) => n + i.length, 0) + files.reduce((n, f) => n + f.data.length, 0) <= MAX_IMAGE_URI_CHARS;
      if (!inline) { fail('DGC couldn’t hand your photos to the Pip; try sending again.'); return; }
      this.pending.set(requestId, { client, command: request.type, at: Date.now(), surface });
      if (!this.send({ type: 'pips_control', request: { ...request, request_id: requestId } }, this.backendIdentity)) { this.pending.delete(requestId); fail('DGC couldn’t send that. Refresh to see whether it worked before trying again.'); }
      return;
    }
    if (generation !== this.generation || !this.state.connected) { await this.unspool(written); fail('The DGC connection changed. Send it again.'); return; }
    const { images: _images, files: _files, ...rest } = request;
    const nested = { ...rest, ...(spooledImages.length ? { spooled_images: spooledImages } : {}), ...(spooledFiles.length ? { spooled_files: spooledFiles } : {}), request_id: requestId };
    this.pending.set(requestId, { client, command: request.type, at: Date.now(), surface, spooled: written });
    if (!this.send({ type: 'pips_control', request: nested }, this.backendIdentity)) {
      this.pending.delete(requestId); await this.unspool(written);
      fail('DGC couldn’t send that. Refresh to see whether it worked before trying again.');
    }
  }
  /** Open a photo from a Pip's chat, the original, in an editor tab (Open in editor, from its pop-up). With `save`
   *  (Download on its row or in its pop-up) the original goes to the page, which saves it on the person's computer under a
   *  name a person can read (src/download.ts); with `view` (its pop-up), the page is handed the original to show. */
  private async openPhoto(message: any, surface = 'main'): Promise<void> {
    const unavailable = () => void vscode.window.showInformationMessage('That photo is no longer available.');
    const pip = message?.pip_id, id = message?.message_id, index = message?.index;
    if (this.apiVersion < 43 || !this.state.connected || typeof pip !== 'string' || !/^pip_[A-Za-z0-9]{1,64}$/.test(pip)
      || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !Number.isSafeInteger(index) || index < 0 || index > 63) { unavailable(); return; }
    const generation = this.generation;
    try {
      const result = await new Promise<any>((resolve, reject) => {
        const requestId = 'pips-photo-' + randomBytes(12).toString('hex');
        const timer = setTimeout(() => { this.hostReads.delete(requestId); reject(new Error('No reply from DGC.')); }, 20000);
        this.hostReads.set(requestId, (event) => {
          clearTimeout(timer); this.hostReads.delete(requestId);
          if (event.type === 'pips_result' && event.ok === true && event.command === 'get_pip_message_image') resolve(event.result); else reject(new Error('DGC could not read the photo.'));
        });
        if (!this.send({ type: 'pips_control', request: { type: 'get_pip_message_image', pip_id: pip, message_id: id, index, ...(this.apiVersion >= 52 ? { as_file: true } : {}), request_id: requestId } }, this.backendIdentity)) {
          clearTimeout(timer); this.hostReads.delete(requestId); reject(new Error('DGC is not connected.'));
        }
      });
      const uri = this.apiVersion >= 52 ? await this.keptImage(result, { pip, message: id, index, generation }) : result?.image;
      const match = typeof uri === 'string' ? /^data:image\/(png|jpeg|gif|webp|bmp);base64,([A-Za-z0-9+/=]+)$/.exec(uri) : null;
      if (!match) { unavailable(); return; }
      // (Copy, from the picture's menu: its bytes go to the page, whose clipboard it is.)
      if (message?.copy === true) { this.post({ type: 'pipsFileCopy', data: uri }, surface); return; }
      if (message?.save === true) {
        await downloadBytes((m) => this.post(m, surface), `Picture ${index + 1}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`, Buffer.from(match[2], 'base64'), `image/${match[1]}`);
        return;
      }
      if (message?.view === true) {
        const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 64) : '';
        this.post({ type: 'pipsPhotoData', requestId, data: uri }, surface);
        return;
      }
      const fs = await import('node:fs/promises');
      const os = await import('node:os');
      const nodePath = await import('node:path');
      // A copy under a name a person can read ("Photo 1.jpg"), not the digest the chat keeps it by.
      const folder = nodePath.join(os.tmpdir(), 'dgc-pip-photos', id);
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      const target = nodePath.join(folder, `Photo ${index + 1}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`);
      await fs.writeFile(target, Buffer.from(match[2], 'base64'), { mode: 0o600 });
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target), { preview: true });
    } catch { unavailable(); }
  }
  /** A file in a Pip's chat (Pips API 101: one the Pip sent with a reply, or one of your own): where DGC keeps it, asked
   *  by the host and checked before anything touches it. Only a regular file where a Pip chat's files are kept, in this
   *  Pip's folder, named by its digest, of the size DGC said; never a link. The page is never told the path. */
  private async messageFile(message: any): Promise<{ path: string; name: string; mime: string; bytes: number; message: string }> {
    const gone = () => new Error('That file is no longer available.');
    const pip = message?.pip_id, id = message?.message_id, index = message?.index;
    if (this.apiVersion < FILES_API || !this.state.connected || typeof pip !== 'string' || !/^pip_[A-Za-z0-9]{1,64}$/.test(pip)
      || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !Number.isSafeInteger(index) || index < 0 || index > 63) throw gone();
    const generation = this.generation;
    const result = await new Promise<any>((resolve, reject) => {
      const requestId = 'pips-file-' + randomBytes(12).toString('hex');
      const timer = setTimeout(() => { this.hostReads.delete(requestId); reject(gone()); }, 30000);
      this.hostReads.set(requestId, (event) => {
        clearTimeout(timer); this.hostReads.delete(requestId);
        if (event.type === 'pips_result' && event.ok === true && event.command === 'get_pip_message_file') resolve(event.result); else reject(gone());
      });
      if (!this.send({ type: 'pips_control', request: { type: 'get_pip_message_file', pip_id: pip, message_id: id, index, request_id: requestId } }, this.backendIdentity)) {
        clearTimeout(timer); this.hostReads.delete(requestId); reject(gone());
      }
    });
    const fs = await import('node:fs/promises');
    const nodePath = await import('node:path');
    if (generation !== this.generation || !this.state.connected) throw gone();
    const path = result?.path, bytes = result?.bytes, name = result?.name, mime = result?.mime;
    if (result?.message_id !== id || result?.index !== index || typeof path !== 'string' || !nodePath.isAbsolute(path)
      || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > KEPT_FILE_BYTES || typeof mime !== 'string' || mime.length > 128
      // Its own name, as a person sees it: no folders, quotes or control characters (dgc/pip_chat.py file_name).
      || typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || /[\/\\"\u0000-\u001f]/.test(name) || Buffer.byteLength(name) > 255) throw gone();
    const info = await fs.lstat(path).catch(() => undefined);
    if (!info || !info.isFile() || info.isSymbolicLink() || info.size !== bytes) throw gone();
    const real = await fs.realpath(path);
    if (!KEPT_FILE.test(nodePath.basename(real)) || nodePath.basename(nodePath.dirname(real)) !== pip
      || nodePath.basename(nodePath.dirname(nodePath.dirname(real))) !== 'chat_files') throw gone();
    return { path: real, name, mime, bytes, message: id };
  }
  /** Open a file from a Pip's chat in an editor tab (a copy under its own name: the kept one is named by its digest and
   *  must stay as it is), or with `save` ask where to save a copy of it. */
  /** Commits and issues as links in a Pip's chat (media/shared/inline.js; src/gitRefs.ts runs git, read-only). The page
   *  names the Pip and the hashes, never a folder: the Pip's folder is read from DGC here, and only a Pip with a folder
   *  that DGC lists has one. Anything else is answered "no remote", and its hashes stay words. */
  private readonly gitRefs = new GitRefs();
  private readonly gitFolders = new Map<string, { folder: string; at: number }>();
  private async pipGitFolder(pipId: string): Promise<string> {
    const kept = this.gitFolders.get(pipId);
    if (kept && Date.now() - kept.at < 60000) return kept.folder;
    let folder = '';
    try {
      const pip = (await this.hostAsk('get_pip', { pip_id: pipId }))?.pip;
      if (pip && pip.source_policy?.mode !== 'personal' && typeof pip.workspace_id === 'string' && pip.workspace_id) {
        const rows = (await this.projectFolders())?.folders;
        const row = Array.isArray(rows) ? rows.find((r: any) => r && r.workspace_id === pip.workspace_id && r.exists !== false && typeof r.folder === 'string' && isAbsolute(r.folder)) : undefined;
        if (row) folder = row.folder;
      }
    } catch { folder = ''; }
    this.gitFolders.set(pipId, { folder, at: Date.now() });
    return folder;
  }
  private async gitRefsAct(message: any, surface: string): Promise<void> {
    const pipId = typeof message?.pip_id === 'string' && /^pip_[A-Za-z0-9]{1,64}$/.test(message.pip_id) ? message.pip_id : '';
    if (!pipId) return;
    const folder = await this.pipGitFolder(pipId);
    if (message.type === 'pipsGitCommitOpen') { if (folder) await openCommit(this.gitRefs, folder, message.hash); return; }
    this.post({ type: 'pipsGitRefs', pip_id: pipId, ...(await this.gitRefs.answer(folder, message.hashes)) }, surface);
  }
  private async openFile(message: any, surface = 'main'): Promise<void> {
    const unavailable = () => void vscode.window.showInformationMessage('That file is no longer available.');
    try {
      const file = await this.messageFile(message);
      if (message?.save === true) { await downloadFile((m) => this.post(m, surface), file.path, file.name, file.mime); return; }
      const fs = await import('node:fs/promises');
      const os = await import('node:os');
      const nodePath = await import('node:path');
      const folder = nodePath.join(os.tmpdir(), 'dgc-pip-files', file.message, String(message.index));
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      const target = nodePath.join(folder, file.name);
      await fs.copyFile(file.path, target);
      await fs.chmod(target, 0o600);
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target), { preview: true });
    } catch { unavailable(); }
  }
  /** A pick from a file's menu in the chat (media/shared/filemenu.js): Open, Open in editor, Save a copy… or Copy, on the
   *  file the page names by its message and its number. DGC is asked where it is kept and the answer is checked
   *  (messageFile); src/fileActs.ts does the rest. Copy path and Reveal are never done: DGC keeps this copy for the chat. */
  private async fileAct(message: any, surface: string): Promise<void> {
    const act = typeof message?.act === 'string' ? message.act : '';
    if (!FILE_ACTS.has(act) || act === 'path' || act === 'reveal' || this.apiVersion < FILES_API) return;
    if (message?.photo === true) {
      // A picture the Pip made: shown and saved as its own buttons do; Copy hands its bytes to the page.
      if (act === 'open' || act === 'save' || act === 'copy') await this.openPhoto({ pip_id: message.pip_id, message_id: message.message_id, index: message.index, save: act === 'save', copy: act === 'copy' }, surface);
      return;
    }
    try {
      const file = await this.messageFile(message);
      const os = await import('node:os'), nodePath = await import('node:path');
      await keptFileAct(act, file, {
        say: (words) => this.post({ type: 'pipsFileSaid', words }, surface),
        picture: (data) => this.post({ type: 'pipsFileCopy', data }, surface),
        copyFolder: async () => nodePath.join(os.tmpdir(), 'dgc-pip-files', file.message, String(message.index)),
        page: (m) => this.post(m, surface),
      });
    } catch { void vscode.window.showInformationMessage('That file is no longer available.'); }
  }
  /** A sent video's or sound's bytes, for its player in the chat (a blob: there, as DGC's own videos are). */
  private async fileData(message: any, surface: string): Promise<void> {
    const requestId = typeof message?.requestId === 'string' ? message.requestId.slice(0, 64) : '';
    try {
      const file = await this.messageFile(message);
      if (!PLAYABLE.test(file.mime)) { this.post({ type: 'pipsFileData', requestId, error: 'That file can\'t be played here.' }, surface); return; }
      const fs = await import('node:fs/promises');
      const raw = await fs.readFile(file.path);
      if (raw.byteLength !== file.bytes) throw new Error('changed');
      this.post({ type: 'pipsFileData', requestId, mime: file.mime, bytes: raw.byteLength, data: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) }, surface);
    } catch { this.post({ type: 'pipsFileData', requestId, error: 'That file is no longer available.' }, surface); }
  }
  receive(message: any, surface = 'main'): void {
    if (surface.startsWith('browser:')) { this.receiveBrowserTab(message, surface); return; }
    const computer = surface.startsWith('computer:') ? this.computers.get(surface.slice(9)) : undefined;
    // (A chat's own tab is the Pips page on another surface: what the Pips page may ask, it may, answered to it.)
    const chat = surface.startsWith('chat:') ? this.chats.get(surface.slice(5)) : undefined;
    if (surface !== 'main' && !computer && !chat) return;
    // (A picture, a chart or a computer's file the page holds, to be saved on the person's computer: src/download.ts.)
    if (takeSave((m) => this.post(m, surface), message)) return;
    if (message?.type === 'pipsOpenChat' && !computer) {
      // Open in editor: this Pip's chat, this conversation, in a tab of its own. The page names both; anything that is
      // not a Pip and a conversation opens nothing. The window's one keeper of these tabs opens it (or this bridge).
      const pip = chatPip(message.pip), conversation = chatConversation(message.conversation);
      if (!pip || conversation === null) return;
      if (this.chatOpener) this.chatOpener(pip, conversation); else this.openChat(pip, conversation);
      return;
    }
    if (message?.type === 'pipsOpenAsker' && !computer) {
      const kind = String(message.kind || ''), id = String(message.id || ''), title = String(message.title || '').slice(0, 200);
      const ok = (kind === 'work' && /^[A-Za-z0-9_.-]{1,128}$/.test(id)) || (kind === 'chatdgc' && /^[A-Za-z0-9_.:-]{1,160}$/.test(id))
        || (kind === 'pip' && /^pip_[0-9a-f]{32}$/.test(id));
      if (ok) this.askerOpener?.({ kind: kind as 'work' | 'chatdgc' | 'pip', id, title });
      return;
    }
    if (message?.type === 'pipsChatDraft' && !computer) { this.chatDraft(surface, message); return; }
    if (message?.type === 'pipsChatShown') { if (chat) this.chatShown(surface, message); return; }
    if (VIDEO_MESSAGES.has(String(message?.type || '')) && !computer && this.pagePanel(surface)) {
      // A Pip reply's video: its bytes and state from DGC's own folder, Open, Show in folder, and a Stop through this
      // window's backend (src/videoHost.ts).
      const panel = this.pagePanel(surface)!;
      void handleVideoMessage(message, reply => { void panel.webview.postMessage(reply); },
                              { stop: this.videoStop, follow: this.videoFollow });
      return;
    }
    if (message?.type === 'mcpApp' && !computer && this.pagePanel(surface)) {
      // A plugin's card in a Pip's reply, in the Pips tab: what it asks goes to this window's backend (src/mcpApps.ts).
      const panel = this.pagePanel(surface)!;
      mcpAppsHost(this.extensionUri).fromPage(message, reply => { void panel.webview.postMessage(reply); },
                                              command => this.send(command, this.backendIdentity));
      return;
    }
    // (Copy too: a Pip tab's Copy puts its text on the clipboard as the side bar's does.)
    if (!computer && ['openFile', 'openExternal', 'openSettings', 'copy', 'codePreview'].includes(String(message?.type))) { this.pageActions?.(message); return; }
    if (message?.type === 'pipsSignIn' && !computer) { openEngineSignIn(String(message.engine || '')); return; }
    if (message?.type === 'pipsOpenYourBrowser' && !computer && !chat) {
      // A Pip's tab in Your Browser, watched in an editor tab beside the chat (Pips API 107; the dock's Browser menu); or
      // (own) your own tab, where the computer DGC runs on has no screen: what open_your_browser answered (view "tab").
      if (this.apiVersion < YOUR_BROWSER_API) return;
      if (message.own === true) { this.openYourBrowserTab(null); return; }
      const pip = chatPip(message.pip, false);
      if (pip) this.openYourBrowserTab({ id: pip.id, name: pip.name });
      return;
    }
    if (message?.type === 'pipsOpenComputer' && !computer) {
      const pip = message.pip;
      if (this.apiVersion >= 43 && pip && typeof pip.id === 'string' && /^pip_[A-Za-z0-9]{1,64}$/.test(pip.id) && typeof pip.name === 'string'
        && pip.name.trim() && pip.name.length <= 120 && PIP_TYPES.includes(pip.pip_type)) {
        // Which of its computers (Pips API 86): a whole number from 1, or the message opens nothing. An older DGC has one tab a Pip.
        const numbered = Object.prototype.hasOwnProperty.call(message, 'number') && this.apiVersion >= 86;
        if (numbered && !computerNumber(message.number)) return;
        this.openComputer({ id: pip.id, name: pip.name.trim(), pip_type: pip.pip_type }, numbered ? message.number : undefined);
      }
      return;
    }
    if (MIC_MESSAGES.includes(message?.type) && !computer) { if (this.dictation) void this.dictation().handle(this.mic, message); return; }
    if (SPEAK_MESSAGES.includes(message?.type) && !computer) { if (this.readAloud) void this.readAloud().handle(this.mic, message); return; }
    if (message?.type === 'pipComputerSave' && computer) { void this.saveComputerFile(surface, message); return; }
    // Big files (Pips API 87): the tab says a folder or a file in Files; the dialogs and every path here are the host's.
    if (message?.type === 'pipComputerAddFiles' && computer) { void this.addComputerFiles(surface, computer, message); return; }
    if (message?.type === 'pipComputerSaveAs' && computer) { void this.saveComputerFileAs(surface, computer, message); return; }
    if (message?.type === 'pipComputerCopy' && computer) {
      // The clipboard panel's Copy: text the Pip's computer copied, put on this computer's clipboard by the host.
      const text = message.text;
      if (typeof text !== 'string' || !text || Buffer.byteLength(text, 'utf8') > COPY_BYTES) { this.post({ type: 'pipComputerCopied', ok: false }, surface); return; }
      void Promise.resolve().then(() => vscode.env.clipboard.writeText(text)).then(
        () => this.post({ type: 'pipComputerCopied', ok: true }, surface), () => this.post({ type: 'pipComputerCopied', ok: false }, surface));
      return;
    }
    // Full screen in a computer tab went on or off: the window follows (ComputerFullScreen).
    if (message?.type === 'pipComputerFull' && computer) { void computerFullScreen.set(computer.panel, message.on === true, this.fullScreenSide); return; }
    if (message?.type === 'pipsOpenPhoto' && !computer) { void this.openPhoto(message, surface); return; }
    if (message?.type === 'pipsOpenFile' && !computer) { void this.openFile(message, surface); return; }
    if (message?.type === 'pipsFileAct' && !computer) { void this.fileAct(message, surface); return; }
    if ((message?.type === 'pipsGitRefs' || message?.type === 'pipsGitCommitOpen') && !computer) { void this.gitRefsAct(message, surface); return; }
    if (message?.type === 'pipsFileData' && !computer) { void this.fileData(message, surface); return; }
    if (message?.type === 'pipsOpenArtifact' && !computer) {
      // A Pip's report document or sheet, or a dashboard it refreshes: in the artifact panel (a document in the editor).
      const id = String(message.id || ''), kind = String(message.artifactType || '');
      // (Pips API 102: what a reply made opens the same way, a page or a deck too.)
      if (this.apiVersion >= 67 && ARTIFACT_ID.test(id) && ['doc', 'sheet', 'dashboard', 'page', 'slides'].includes(kind)) this.artifacts?.()?.open(id, { type: kind });
      return;
    }
    if (message?.type === 'pipsFiles' && !computer) {
      // A project Pip's @ list: the files of this window's folders, by the paths the Pip reads them at.
      void workspaceFiles().then(files => this.post({ type: 'pipsFiles', files: files.map(f => ({ label: f.relative_path })) }, surface), () => {});
      return;
    }
    if (message?.type === 'pipsPluginLogos' && !computer) {
      // The logos of the plugins a Pip's replies used ("Used [logo] Aave"), by id; "" for one with none.
      const ids = Array.isArray(message.plugins) ? message.plugins.filter((id: unknown) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)).slice(0, 16) : [];
      if (!ids.length) return;
      const logos: Record<string, string> = {};
      for (const id of ids) logos[id] = this.pluginLogo?.(id) || '';
      this.post({ type: 'pipsPluginLogos', logos }, surface);
      return;
    }
    if (message?.type === 'pipsAppLogos' && !computer) {
      // The logos of the apps in a Pip's "Apps it can use" (its Composio toolkits), by id; "" for one DGC ships none for.
      const ids = Array.isArray(message.apps) ? message.apps.filter((id: unknown) => typeof id === 'string' && APP_ID.test(id)).slice(0, 16) : [];
      if (!ids.length) return;
      const logos: Record<string, string> = {};
      for (const id of ids) logos[id] = appLogoData(this.extensionUri, id);
      this.post({ type: 'pipsAppLogos', logos }, surface);
      return;
    }
    if (message?.type === 'pipDesktop' && computer) {
      // The screen's viewer: bytes in base64, for this tab's own Pip only.
      const op = message.op, data = message.data;
      if (!this.desktopStream || !this.state.connected || !['open', 'send', 'close'].includes(op)) return;
      if (op === 'send' && (typeof data !== 'string' || !data || data.length > 1_400_000 || !/^[A-Za-z0-9+/=]+$/.test(data))) return;
      // One stream per Pip. Opening it here moves it here, and the tab that had it is told where it went; a tab without
      // it can neither type into it nor close it. A tab opens its own computer's screen and no other.
      const key = surface.slice(9), pipId = computer.pip.id, owner = this.desktopOwner.get(pipId);
      if (op === 'open') {
        if (Object.prototype.hasOwnProperty.call(message, 'number') && message.number !== computer.number) return;
        if (owner !== undefined && owner !== key && this.computers.has(owner)) this.post({ type: 'pipDesktopElsewhere', number: computer.number ?? 1, name: this.computerName(pipId, computer.number ?? 1) || 'its computer' }, 'computer:' + owner);
        this.desktopOwner.set(pipId, key);
        this.send({ type: 'pip_desktop', pip_id: pipId, op, ...(this.desktopNumbers && computer.number ? { number: computer.number } : {}) }, this.backendIdentity);
        return;
      }
      if (owner !== undefined && owner !== key) return;
      if (op === 'close') this.desktopOwner.delete(pipId);
      this.send({ type: 'pip_desktop', pip_id: pipId, op, ...(op === 'send' ? { data } : {}) }, this.backendIdentity);
      return;
    }
    if (!computer && this.folds?.remember(message)) return;
    if (!computer && this.dock?.handle(message, (state) => this.postPages(state))) return;
    if (message?.type === 'pipsReady') {
      if (!computer && this.folds) this.post(this.folds.initial(), surface);
      if (!computer && this.dock) this.post(this.dock.state(), surface);
      if (chat) {
        // Its page finds its own way to its chat (its body names the Pip and the conversation). What is in that
        // conversation's box in another page is in this one's from the start.
        this.publish();
        const draft = PipsEditor.drafts.get(this.chatKey(chat));
        if (draft) this.post(draft, surface);
        return;
      }
      if (computer) { this.post({ type: 'pipComputerInit', pip: computer.pip, desktop: this.desktopStream,
        ...(computer.number ? { number: computer.number, name: this.computerName(computer.pip.id, computer.number), numbers: this.desktopNumbers } : {}) }, surface); this.post({ type: 'pipsConnection', generation: this.generation, apiVersion: this.apiVersion, backgroundSetup:this.backgroundSetup, ...this.state }, surface); }
      else {
        this.publish();
        if (this.panelNavigation) this.post({ type: 'pipsNavigate', navigation: this.panelNavigation });
      }
      return;
    }
    if (message?.type === 'pipsReconnect') { this.pending.clear(); this.generation++; this.connectFailed = false; this.connect(); this.publish(); return; }
    // The Project Folder dropdown in the Pips view: a choice made there is the extension's to keep (All projects, or a
    // folder DGC listed), and Add a folder… is the editor's own folder picker.
    if (message?.type === 'pipsProjectFolderChoose') {
      if (computer || !this.foldersOn || !this.projectFolderHook) return;
      const folder = message.folder === '' ? '' : fullFolder(message.folder);
      if (message.folder === '' || folder && this.listedFolders.has(folder)) this.projectFolderHook.choose(folder);
      return;
    }
    // ChatGPT · your plan's Connect and the usage meter, from a Pip's chat (the panel's, through usePlan).
    if (!computer && this.planHooks && ['pipPlanConnect', 'pipPlanCancel', 'pipUsageMeter', 'pipOpenUsagePage'].includes(String(message?.type))) {
      const hooks = this.planHooks;
      if (message.type === 'pipPlanCancel') hooks.cancel();
      else if (message.type === 'pipOpenUsagePage') hooks.openUsage(message.source, message.page);
      else if (message.type === 'pipPlanConnect') {
        void hooks.connect((said) => this.post({ ...said, type: 'pipPlanConnecting' }, surface), typeof message.id === 'string' && /^provider_[a-f0-9]{32}$/.test(message.id) ? message.id : '')
          .then((ok) => { if (ok) this.modelsChanged(); });
      } else if (typeof message.pip_id === 'string' && /^pip_[a-f0-9]{32}$/.test(message.pip_id)) {
        void hooks.usage(message.model_choice, message.fresh === true).then((said) => this.post({ ...said, type: 'pipUsageMeter', pip_id: message.pip_id }, surface), () => undefined);
      }
      return;
    }
    if (message?.type === 'pipsPickFolder') {
      if (computer || !this.foldersOn || typeof message.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(message.id)) return;
      void this.pickFolder(message.id, surface);
      return;
    }
    if (message?.type !== 'pipsRequest' || typeof message.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(message.id)) return;
    const fail = (text: string) => this.post({ type: 'pipsReply', id: message.id, ok: false, error: { message: text } }, surface);
    { const windowFolder = fullFolder(vscode.workspace?.workspaceFolders?.[0]?.uri?.fsPath);
      const refused = projectFoldersRefusal(message.request, this.apiVersion, (folder) => this.pickedFolders.has(folder) || this.listedFolders.has(folder) || (!!windowFolder && folder === windowFolder)); if (refused) { fail(refused); return; } }
    // Your own tab in Your Browser: only its own editor tab asks for it (receiveBrowserTab), never this page.
    if (asksForYourOwnTab(message.request)) { fail('Only Your Browser’s own tab shows your tabs.'); return; }
    // The copy commands carry a path on this computer: no page sends one, whichever page it is.
    if (COMPUTER_COPY_COMMANDS.has(message.request?.type)) { fail(this.apiVersion < COMPUTER_COPY_API ? 'Update DGC to copy files over 2 MB.' : 'Use Add file… or Save to this computer… in the computer’s Files.'); return; }
    // A computer tab is pinned to its own Pip and to the computer's commands.
    if (computer) { const refused = computerTabRefusal(message.request, computer.pip.id); if (refused) { fail(refused); return; } }
    // And to its own one of them: a tab says no other computer's number.
    if (computer && Object.prototype.hasOwnProperty.call(message.request, 'number') && message.request.number !== computer.number) { fail('This tab only uses this computer.'); return; }
    if (this.requireGeneration && message.generation !== this.generation) { fail('This view is from an earlier connection. Refresh and try again.'); return; }
    if (!this.state.connected || !this.state.supported) { fail('Pips aren’t available. Update DGC, then reconnect.'); return; }
    for (const [id, item] of this.pending) if (Date.now() - item.at > 60000) this.pending.delete(id);
    if (this.pending.size >= 64) { fail('DGC is busy. Reconnect and try again.'); return; }
    const request = message.request;
    if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.type !== 'string') return;
    if (request.type === 'pip_model_window') {
      // A Pip's Sub-agents page (Pips API 104): the most tokens the chosen model takes. The host asks DGC itself
      // (model_window_at) with the saved provider's address and key; nothing of either reaches the page.
      if (this.apiVersion < AGENTS_OWN_API || !this.modelWindow) { fail('Update DGC to see the sizes a model takes.'); return; }
      const c = request.model_choice;
      if (!c || typeof c !== 'object' || !ownModelId(c.model) || !(c.mode === 'model' || (c.mode === 'provider' && OWN_PROVIDER.test(String(c.provider))))) { fail('Choose a model on DGC’s connection or a saved provider.'); return; }
      const choice = c.mode === 'model' ? { mode: 'model' as const, model: String(c.model) } : { mode: 'provider' as const, provider: String(c.provider), model: String(c.model) };
      const answer = (window: unknown) => this.post({ type: 'pipsReply', id: message.id, ok: true, result: { window: Number.isSafeInteger(window) && Number(window) > 0 ? Number(window) : 0 } }, surface);
      void this.modelWindow(choice).then(answer, () => answer(0));
      return;
    }
    // No provider yet: a Pip's hello has nothing to run on. Nothing is queued; the Pip says hello once one is saved.
    if (request.type === 'introduce_pip' && this.savedProviders?.none()) {
      this.post({ type: 'pipsReply', id: message.id, ok: true, result: { no_provider: true } }, surface);
      return;
    }
    // A Pip set to a saved provider: the host saves that provider first, so the choice's check and its runs find it.
    // A Pip's fallback on a saved provider (D14) is saved the same way.
    // (And the sub-agents' own model or fallback on one, Pips API 104: checked first, so a request DGC won't take saves nothing.)
    if (request.type === 'set_pip_agents') { const refused = pipAgentsRefusal(request, this.apiVersion); if (refused) { fail(refused); return; } }
    const chosen = request.model_choice ?? request.changes?.model_choice
      ?? (request.type === 'set_pip_backup' && typeof request.provider === 'string' && request.provider && request.model
        ? { mode: 'provider', provider: request.provider, model: request.model } : undefined)
      ?? (request.type === 'set_pip_agents' && typeof request.fallback?.provider === 'string' && request.fallback.provider && request.fallback.model
        ? { mode: 'provider', provider: request.fallback.provider, model: request.fallback.model } : undefined);
    if (chosen?.mode === 'provider' && message.providerSaved !== true) {
      if (!this.savedProviders) { fail('Update DGC to run a Pip on a saved provider.'); return; }
      void this.savedProviders.save(String(chosen.provider), String(chosen.model || '')).then(
        () => this.receive({ ...message, providerSaved: true }, surface),
        (error: unknown) => fail(error instanceof Error && error.message ? error.message : 'DGC could not save this provider for your Pips.'));
      return;
    }
    if ((request.type === 'learn_skill' || request.type === 'save_skill') && !computer) {
      // /learn in a Pip's chat: not a Pip control but the editor's own command (the draft is shown before anything is
      // written, and Save writes a personal skill, ~/.dgc/skills).
      if (!this.learn) { fail('Update DGC to turn a Pip’s work into a skill with /learn.'); return; }
      const keys = request.type === 'learn_skill' ? ['type', 'pip_id', 'request'] : ['type', 'pip_id', 'markdown'];
      if (Object.keys(request).some(key => !keys.includes(key)) || typeof request.pip_id !== 'string' || !/^pip_[0-9a-f]{32}$/.test(request.pip_id)
        || (request.type === 'learn_skill' && request.request !== undefined && (typeof request.request !== 'string' || request.request.length > 1000))
        || (request.type === 'save_skill' && (typeof request.markdown !== 'string' || !request.markdown.trim() || request.markdown.length > 65536))) {
        fail('That skill request is malformed.'); return;
      }
      const requestId = 'pips-learn-' + randomBytes(12).toString('hex');
      const command = request.type === 'learn_skill'
        ? { type: 'learn_skill', request_id: requestId, pip_id: request.pip_id, ...(request.request ? { request: request.request } : {}) }
        : { type: 'save_skill', request_id: requestId, pip_id: request.pip_id, markdown: request.markdown, scope: 'user' };
      // A draft is a model's answer: its entry outlives the 60 s a Pip control gets (the host prunes by `at`).
      this.pending.set(requestId, { client: message.id, command: request.type, at: Date.now() + (request.type === 'learn_skill' ? 240000 : 0), surface });
      if (!this.send(command, this.backendIdentity)) { this.pending.delete(requestId); fail('DGC couldn’t send that. Try again.'); }
      return;
    }
    // @ a project in a Personal Pip's chat (Pips API 91): an older DGC has no copies to list, apply or discard.
    { const refused = pipProjectsRefusal(request, this.apiVersion); if (refused) { fail(refused); return; } }
    // @ a Pip (Pips API 111): a job's card in the Pips page reads the job and answers Start / Not now.
    { const refused = pipJobsRefusal(request, this.apiVersion); if (refused) { fail(refused); return; } }
    // Your Browser from the side bar (Pips API 107): the dock's and Home's Browser, and Install Google Chrome.
    { const refused = yourBrowserHomeRefusal(request, this.apiVersion); if (refused) { fail(refused); return; } }
    // A Project Pip's owner session (Pips API 89): an older DGC keeps no owner to read or set.
    { const refused = pipOwnersRefusal(request, this.apiVersion); if (refused) { fail(refused); return; } }
    // A Personal Pip's goal (Pips API 92): an older DGC has none to set, read or stop.
    { const refused = pipGoalsRefusal(request, this.apiVersion); if (refused) { fail(refused); return; } }
    { const refused = pipFlowRefusal(request, this.apiVersion); if (refused) { fail(refused); return; } }
    { const refused = pipAgentsRefusal(request, this.apiVersion); if (refused) { fail(refused); return; } }
    if (request.type === WORK_SESSIONS_COMMAND) {
      // The titles the editor's Work list shows, for the owner picker: the editor's own answer, never a Pip control.
      if (computer) { fail('This tab only uses this Pip\'s computer.'); return; }
      const forPip = this.foldersOn && typeof request.pip_id === 'string' && /^pip_[0-9a-f]{32}$/.test(request.pip_id) ? request.pip_id : undefined;
      void Promise.resolve().then(() => this.workSessions ? this.workSessions(forPip) : []).then(
        list => this.post({ type: 'pipsReply', id: message.id, ok: true, result: { sessions: workSessionTitles(list) } }, surface),
        () => this.post({ type: 'pipsReply', id: message.id, ok: true, result: { sessions: [] } }, surface));
      return;
    }
    if (request.type === PROJECT_WORK_COMMAND) {
      // Continue in Work: the editor opens the Work chat itself; this is never a Pip control.
      if (computer || !projectWorkRequest(request)) { fail('That change can’t be opened in Work from here.'); return; }
      this.openProjectWork(request).then(
        () => this.post({ type: 'pipsReply', id: message.id, ok: true, result: { opened: true } }, surface),
        error => fail(error instanceof Error && error.message ? error.message : 'Work didn’t open. Choose Continue in Work again when you’re ready.'));
      return;
    }
    if (request.type === 'list_artifact_dashboards' && !computer) {
      // The person's dashboards, for a Pip's "Dashboards it refreshes" (Pips API 67): the editor's own artifacts list,
      // as the Library's Artifacts tab asks it (artifact_list), never a Pip control.
      const hub = this.artifacts?.();
      if (this.apiVersion < 67) { fail('Update DGC to have a Pip refresh your dashboards.'); return; }
      if (!hub?.offers()) { fail('This DGC keeps no dashboards yet. Run “DGC: Update CLI”, then reconnect.'); return; }
      hub.list('dashboard').then(
        items => this.post({ type: 'pipsReply', id: message.id, ok: true, result: { dashboards: items.filter(item => item.type === 'dashboard').slice(0, 500)
          .map(({ id, title, version }) => ({ id, title, version })) } }, surface),
        error => fail(`Your dashboards didn’t load: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (request.type === 'export_pip_file' || request.type === 'import_pip_file') {
      if (this.apiVersion < 41) { fail('Update DGC to share Pips.'); return; }
      if (request.type === 'import_pip_file') {
        if (Object.keys(request).some(key => key !== 'type')) { fail('Choose a shared Pip file to import.'); return; }
        void this.importFile(message.id, surface); return;
      }
      if (Object.keys(request).some(key => !['type','pip_id'].includes(key)) || typeof request.pip_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.pip_id)) { fail('Choose a Pip to export.'); return; }
      const requestId = 'pips-export-' + randomBytes(12).toString('hex');
      this.pending.set(requestId, { client: message.id, command: 'export_pip', at: Date.now(), surface, exportFile: { generation: this.generation } });
      if (!this.send({ type: 'pips_control', request: { type: 'export_pip', pip_id: request.pip_id, request_id: requestId } }, this.backendIdentity)) {
        this.pending.delete(requestId); fail('DGC could not export the Pip.');
      }
      return;
    }
    if (request.type === 'export_pip_team_file' || request.type === 'import_pip_team_file') {
      // pips-12: a whole team as one file. The page names the Pips and the team; the host shows the dialog and holds the file.
      if (this.apiVersion < 88) { fail('Update DGC to share a team of Pips.'); return; }
      if (request.type === 'import_pip_team_file') {
        if (Object.keys(request).some(key => key !== 'type')) { fail('Choose a team file to import.'); return; }
        void this.importTeamFile(message.id, surface); return;
      }
      const ids = request.pip_ids;
      if (Object.keys(request).some(key => !['type','pip_ids','name'].includes(key)) || !Array.isArray(ids) || !ids.length || ids.length > TEAM_PIPS
        || ids.some((id: unknown) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) || new Set(ids).size !== ids.length) { fail('Choose 1 to 20 Pips to share as a team.'); return; }
      if (typeof request.name !== 'string' || [...request.name].length > 80 || /[\u0000-\u001f\u007f]/.test(request.name)) { fail('A team’s name is one line of up to 80 characters.'); return; }
      const requestId = 'pips-export-' + randomBytes(12).toString('hex');
      this.pending.set(requestId, { client: message.id, command: 'export_pip_team', at: Date.now(), surface, exportTeam: { generation: this.generation } });
      if (!this.send({ type: 'pips_control', request: { type: 'export_pip_team', pip_ids: ids, name: request.name, request_id: requestId } }, this.backendIdentity)) {
        this.pending.delete(requestId); fail('DGC could not export the team.');
      }
      return;
    }
    if (request.type === 'open_pip_document') {
      if (Object.keys(request).some(key => !['type','run_id','save'].includes(key)) || !/^run_[a-f0-9]{32}$/.test(request.run_id) || typeof request.save !== 'boolean') {
        fail('Choose a saved Pip result to open.'); return;
      }
      const requestId = 'pips-document-' + randomBytes(12).toString('hex');
      this.pending.set(requestId, {client:message.id, command:'get_pip_run', at:Date.now(), surface, document:{run:request.run_id, save:request.save, generation:this.generation}});
      if (!this.send({type:'pips_control', request:{type:'get_pip_run', run_id:request.run_id, request_id:requestId}}, this.backendIdentity)) {
        this.pending.delete(requestId); fail('DGC could not read the saved result.');
      }
      return;
    }
    if (['get_pip_connector_draft','list_pip_connector_drafts','prepare_pip_connector_draft','dismiss_pip_connector_draft'].includes(request.type) && this.apiVersion < 37) { fail('Update DGC for app action drafts.'); return; }
    if (['get_pip_calendar_draft','list_pip_calendar_drafts','prepare_pip_calendar_draft','dismiss_pip_calendar_draft'].includes(request.type) && this.apiVersion < 35) { fail('Update DGC for calendar drafts.'); return; }
    if (['get_pip_message_draft','list_pip_message_drafts','prepare_pip_message_draft','dismiss_pip_message_draft'].includes(request.type) && this.apiVersion < 32) { fail('Update DGC for email drafts.'); return; }
    if (['inspect_pip_connector_actions','propose_pip_connector_action'].includes(request.type) && this.apiVersion < 36) { fail('Update DGC for app actions.'); return; }
    if (['inspect_pip_calendar_connection','propose_pip_calendar_action'].includes(request.type) && this.apiVersion < 34) { fail('Update DGC to add calendar events.'); return; }
    if (['inspect_pip_send_connection', 'propose_pip_app_action', 'get_pip_app_action', 'list_pip_app_actions', 'accept_pip_app_action', 'reject_pip_app_action'].includes(request.type) && this.apiVersion < 31) { fail('Update DGC to send email from a Pip.'); return; }
    if (request.type === 'propose_pip_personal_handoff' && this.apiVersion < 30) { fail('Update DGC to share results between Pips.'); return; }
    if (request.type === 'list_pip_accounts' && this.apiVersion < 29) { fail('Update DGC to choose an account.'); return; }
    if (request.type === 'revise_pip_setup' && this.apiVersion < 25) { fail('Update DGC to change the model on a new-Pip card.'); return; }
    // API 55: a Personal Pip on the user's own Claude Code or Codex (model_choice mode "subscription").
    if ([request.model_choice, request.changes?.model_choice].some(choice => choice?.mode === 'subscription') && this.apiVersion < 55) { fail('Update DGC to run a Pip on your own Claude Code or Codex.'); return; }
    // API 70: a Pip on DGC Router (model_choice mode "router").
    if ([request.model_choice, request.changes?.model_choice].some(choice => choice?.mode === 'router') && this.apiVersion < 70) { fail('Update DGC to run a Pip on DGC Router.'); return; }
    // Display-only, and only to a DGC that keeps them. Anything off leaves the plain words in the bubble.
    if (request.type === 'send_pip_message' && Object.prototype.hasOwnProperty.call(request, 'display_mentions')) {
      // (A project's mark asks for its copy: only of a DGC that makes one, Pips API 91.)
      const marks = this.displayMentions ? displayMentions(request.display_mentions, this.apiVersion >= PROJECTS_API ? ['project'] : []) : undefined;
      if (marks) request.display_mentions = marks; else delete request.display_mentions;
    }
    // A question card under a Pip's reply (Pips API 106): this view draws it (send_pip_message `questions`), and answers
    // or closes it (answer_pip_questions). An older DGC is never told so, nor asked.
    if (request.type === 'send_pip_message' && Object.prototype.hasOwnProperty.call(request, 'questions')
        && (this.apiVersion < QUESTIONS_API || request.questions !== true)) delete request.questions;
    if (request.type === 'answer_pip_questions') {
      const refused = questionsRefusal(request, this.apiVersion);
      if (refused) { fail(refused); return; }
    }
    // The output a message asks its reply to make (Pips API 100): one of Work's five, and only to a DGC that takes it.
    if (request.type === 'send_pip_message' && Object.prototype.hasOwnProperty.call(request, 'output')
        && (this.apiVersion < 100 || !['document', 'slides', 'spreadsheet', 'page', 'dashboard'].includes(request.output))) delete request.output;
    if (request.type === 'send_pip_message' && Object.prototype.hasOwnProperty.call(request, 'chat_options') && this.apiVersion < 24) { fail('Update DGC to change context and thinking.'); return; }
    if (request.type === 'send_pip_message' && Number(request.chat_options?.context_size) > 32768 && this.apiVersion < 25) { fail('Update DGC for a context window above 32K tokens.'); return; }
    if (['propose_pip_calendar_action','prepare_pip_calendar_draft'].includes(request.type) && request.event && ['attendees','repeat','send_invitations'].some(key => Object.prototype.hasOwnProperty.call(request.event,key)) && this.apiVersion < 38) { fail('Update DGC for calendar invitations and repeating events.'); return; }
    if (request.type === 'propose_pip_update' && Object.prototype.hasOwnProperty.call(request.changes || {}, 'web_plan') && this.apiVersion < 40) { fail('Update DGC for web reads.'); return; }
    if (request.type === 'propose_pip_update' && request.changes?.app_plan?.schema_version === 3 && this.apiVersion < 39) { fail('Update DGC to read Drive, Notion and Contacts.'); return; }
    if (request.type === 'propose_pip_update' && request.changes?.app_plan?.schema_version === 2 && this.apiVersion < 33) { fail('Update DGC to read upcoming days from a calendar.'); return; }
    if ((['list_pip_connections','inspect_pip_connection'].includes(request.type) || request.type === 'propose_pip_update' && Object.prototype.hasOwnProperty.call(request.changes || {}, 'app_plan')) && this.apiVersion < 28) { fail('Update DGC for app reads.'); return; }
    if (['list_pip_setups', 'get_pip_setup', 'accept_pip_setup', 'reject_pip_setup'].includes(request.type) && this.apiVersion < 23) { fail('Update DGC for new-Pip cards in the chat.'); return; }
    if ((['get_pip_proposal', 'list_pip_adaptations'].includes(request.type) || request.type === 'propose_pip_update' && (request.changes?.adaptation_policy !== undefined || request.changes?.event_trigger !== undefined)) && this.apiVersion < 10) { fail('Update DGC for saved changes, self-changes and events.'); return; }
    if ((request.type === 'propose_pip_update' && Object.prototype.hasOwnProperty.call(request.changes || {}, 'verification_plan') || request.type === 'run_pip' && ['expected_version', 'expected_lifecycle_revision', 'expected_plan_digest'].some(key => Object.prototype.hasOwnProperty.call(request, key))) && this.apiVersion < 21) { fail('Update DGC for Pulse command plans.'); return; }
    // A live-data Pip's approved read-only commands (Pips API 60, dgc/pip_live_data.py).
    if (request.type === 'propose_pip_update' && Object.prototype.hasOwnProperty.call(request.changes || {}, 'live_plan') && this.apiVersion < 60) { fail('Update DGC to keep an eye on live data.'); return; }
    if (request.type === 'propose_pip_update' && (Object.prototype.hasOwnProperty.call(request.changes?.event_trigger || {}, 'commit_paths') || Array.isArray(request.changes?.event_trigger?.events) && request.changes.event_trigger.events.includes('committed_paths_changed')) && this.apiVersion < 22) { fail('Update DGC to watch paths.'); return; }
    if (request.type === 'propose_pip_update' && Array.isArray(request.changes?.event_trigger?.events) && request.changes.event_trigger.events.includes('session_turn_completed') && this.apiVersion < 18) { fail('Update DGC to run a Pip after a chat turn.'); return; }
    if (request.type === 'propose_pip_update' && request.changes?.source_policy !== undefined && this.apiVersion < 11) { fail('Update DGC to change what a Pip reads.'); return; }
    if (['list_workspace_execution_receipts', 'get_workspace_execution_receipt', 'record_workspace_execution_context'].includes(request.type) && this.apiVersion < 17) { fail('Update DGC for check command results.'); return; }
    if ((['archive_pip', 'restore_pip'].includes(request.type) || ['pause_pip', 'resume_pip'].includes(request.type) && request.expected_lifecycle_revision !== undefined) && this.apiVersion < 16) { fail('Update DGC to archive or restore Pips.'); return; }
    if (request.type === 'delete_archived_pip' && this.apiVersion < 68) { fail('Update DGC to permanently delete archived Pips.'); return; }
    if (request.action && Object.prototype.hasOwnProperty.call(request.action, 'specialists') && this.apiVersion < 15) { fail('Update DGC to use helpers.'); return; }
    if (['get_pip_statement_anchor', 'record_pip_statement', 'revoke_pip_statement', 'list_pip_statements'].includes(request.type) && this.apiVersion < 19) { fail('Update DGC for claims and preferences.'); return; }
    if (['get_pip_exception_source', 'record_pip_exception', 'revoke_pip_exception', 'list_pip_memories'].includes(request.type) && this.apiVersion < 14) { fail('Update DGC for exceptions.'); return; }
    if (['list_pip_notifications', 'mark_pip_notification_read'].includes(request.type) && this.apiVersion < 13) { fail('Update DGC for notifications.'); return; }
    if ((request.type === 'list_workspace_sessions' || request.type.includes('workspace_session_outcome')) && this.apiVersion < 12) { fail('Update DGC for session statements.'); return; }
    const requestId = 'pips-editor-' + randomBytes(12).toString('hex');
    if (request.type === 'propose_pip_update' && Object.prototype.hasOwnProperty.call(request.changes || {}, 'github_plan') && this.apiVersion < 41) { fail('Update DGC for GitHub reads.'); return; }
    if (request.type === 'propose_pip_update' && Object.prototype.hasOwnProperty.call(request.changes || {}, 'computer_plan') && this.apiVersion < 42) { fail('Update DGC to give a Pip a computer.'); return; }
    if(['finish_pip_computer_check','list_pip_app_links','start_pip_app_link','check_pip_app_link','decline_pip_app_link','disconnect_pip_app_link'].includes(request.type) && this.apiVersion < 43) { fail('Update DGC to connect apps to a Pip.'); return; }
    if(['list_pip_routines','add_pip_routine','update_pip_routine','delete_pip_routine','decide_pip_routine'].includes(request.type) && this.apiVersion < 43) { fail('Update DGC for routines.'); return; }
    if(['set_pip_profile','list_pip_shared','get_pip_computers','update_pip_computers','reset_pip_computer','list_pip_apps'].includes(request.type) && this.apiVersion < 43) { fail('Update DGC to use this.'); return; }
    if(['list_pip_plugins','allow_pip_plugin','decline_pip_plugin','list_pip_plugin_uses','list_pip_attention','list_pip_notes','add_pip_note','forget_pip_note','list_pip_sites','set_pip_careful','forget_pip_site','get_pip_chat_context','list_pip_reply_stats','get_pips_limit','set_pips_limit'].includes(request.type) && this.apiVersion < 44) { fail('Update DGC to let a Pip use your plugins.'); return; }
    { const refused = keysRefusal(request, this.apiVersion); if (refused) { fail(refused); return; } }
    // API 82: a Personal Pip's own API keys (its card's Save and Not now, and Remove on its page).
    { const refused = pipKeyRefusal(request, this.apiVersion); if (refused) { fail(refused); return; } }
    if(request.type === 'set_plugin_permission' && this.apiVersion < 45) { fail('Update DGC to choose what a plugin may do without asking.'); return; }
    if(request.type === 'introduce_pip' && this.apiVersion < 43) { fail('Update DGC for Pips that say hello.'); return; }
    if(request.type === 'send_pip_message' && Object.prototype.hasOwnProperty.call(request, 'files') && this.apiVersion < 43) { fail('Update DGC to send files to a Pip.'); return; }
    if (request.type === 'library_pip_message_image' && this.apiVersion < 106) { fail('Update DGC to save a picture in the Library.'); return; }
    if((request.type === 'get_pip_message_image' || request.type === 'send_pip_message' && Object.prototype.hasOwnProperty.call(request, 'images')) && this.apiVersion < 43) { fail('Update DGC to send images to a Pip.'); return; }
    if(['list_pip_computer_files','read_pip_computer_file','add_pip_computer_file','remove_pip_computer_file','run_pip_computer_command','list_pip_computer_terminal','get_pip_computer_desktop'].includes(request.type) && this.apiVersion < 43) { fail('Update DGC for a Pip computer’s Files and Terminal.'); return; }
    if(['always_allow_pip_computer_action','get_pip_computer','list_pip_computer_actions','decide_pip_computer_action','get_pip_computer_frame','list_pip_computer_frames','stop_pip_computer','open_pip_computer','use_pip_computer_view'].includes(request.type) && this.apiVersion < 42) { fail('Update DGC for Pip computers.'); return; }
    if(['always_allow_pip_app_action','list_pip_action_grants','revoke_pip_action_grant'].includes(request.type) && this.apiVersion < 41) { fail('Update DGC to let a Pip act without asking.'); return; }
    if(['set_pip_feedback','list_pip_feedback'].includes(request.type) && this.apiVersion < 41) { fail('Update DGC to rate Pip results.'); return; }
    if(request.type === 'mark_pip_news_seen' && this.apiVersion < 48) { fail('Update DGC to dismiss a Pip\'s news.'); return; }
    if(request.type === 'set_pip_chat_options' && this.apiVersion < 47) { fail('Update DGC to keep a Pip\'s context and thinking.'); return; }
    if(['check_pip_source','get_pip_run_source'].includes(request.type) && this.apiVersion < 50) { fail('Update DGC to check what a Pip\'s source copy leaves out.'); return; }
    if(request.type === 'list_pip_run_posts' && this.apiVersion < 51) { fail('Update DGC to see a Pip\'s runs in its chat.'); return; }
    if(['list_pip_flows','get_pip_flow','create_pip_flow','set_pip_flow'].includes(request.type) && this.apiVersion < 72) { fail('Update DGC for Pip workflows.'); return; }
    { const refused = conversationsRefusal(request, this.apiVersion); if (refused) { fail(refused); return; } }
    { const refused = computerNamesRefusal(request, this.apiVersion); if (refused) { fail(refused); return; } }
    { const refused = computerScreenRefusal(request, this.apiVersion); if (refused) { fail(refused); return; } }
    { const refused = pipAppsRefusal(request, this.apiVersion); if (refused) { fail(refused); return; } }
    { const refused = pipTeamsRefusal(request, this.apiVersion); if (refused) { fail(refused); return; } }
    { const refused = pipImportsRefusal(request, this.apiVersion); if (refused) { fail(refused); return; } }
    if(['list_pip_unread','mark_pip_read'].includes(request.type) && this.apiVersion < 69) { fail('Update DGC to track unread Pip messages.'); return; }
    if(request.type === 'list_pip_run_fixes' && this.apiVersion < 65) { fail('Update DGC to see what it fixed in a Pip\'s chat.'); return; }
    // API 53: a Pip's eyes and cursor (how a text-only Pip sees; where it clicked, in the timeline and the live view).
    if((['get_pip_eyes','set_pip_eyes'].includes(request.type) || request.type === 'list_pip_computer_frames' && Object.prototype.hasOwnProperty.call(request, 'pointers')
      || request.type === 'use_pip_computer_view' && request.op === 'pointer') && this.apiVersion < 53) { fail('Update DGC to see where a Pip clicks and choose how it sees.'); return; }
    // API 54: Pips use the whole desktop; the image editor, document editor and PDF viewer it lacks are offered once.
    if(['get_pip_computer_apps','set_pip_computer_apps'].includes(request.type) && this.apiVersion < 54) { fail('Update DGC for the apps on a Pip\'s computer.'); return; }
    // API 56: saved logins. DGC types a login the user saved into the Pip's page itself; a save carries the password
    // and the authenticator key to the backend's sealed store and nowhere else (never kept here, never logged).
    if(['list_pip_logins','save_pip_login','remove_pip_login','grant_pip_login'].includes(request.type) && this.apiVersion < 56) { fail('Update DGC to save logins for your Pips.'); return; }
    // API 98: the code card. The code a site sent, typed on its card, goes to DGC once and is never kept or logged here.
    { const refused = fillCodeRefusal(request, this.apiVersion); if (refused) { fail(refused); return; } }
    // API 57: a Pip's own working notes, and its daily log.
    if(['get_pip_working_notes','set_pip_working_notes','list_pip_daily_log'].includes(request.type) && this.apiVersion < 57) { fail('Update DGC to see a Pip\'s working notes and daily log.'); return; }
    // API 58: how much a Personal Pip asks (Ask me first, Approve for me, Do it all). An older DGC has no levels: every Pip asks.
    if(['get_pip_level','set_pip_level'].includes(request.type) && this.apiVersion < 58) { fail('Update DGC to choose how much a Pip asks.'); return; }
    // API 59: a Personal Pip may borrow your own signed-in Chrome, with your consent each time. An older DGC has no cards to answer.
    if(['list_pip_borrows','allow_pip_borrow','decline_pip_borrow','stop_pip_borrow'].includes(request.type) && this.apiVersion < 59) { fail('Update DGC to let a Pip borrow your Chrome.'); return; }
    // API 61: your own apps' tools (registered by your code with DGC's SDK). An older DGC has none to list or accept.
    if(['list_apps','accept_app_update'].includes(request.type) && this.apiVersion < 61) { fail('Update DGC to see your own apps.'); return; }
    // API 63: the events your own app sent lately, the Routines form's suggestions.
    if(request.type === 'list_app_events' && this.apiVersion < 63) { fail('Update DGC for routines on your app\'s events.'); return; }
    // API 90: a routine a service calls at its own secret address (webhooks in, fully local). A request carries no
    // address; an answer does, and the signing secret goes one way only: neither is kept or logged here.
    if(request.type === 'list_pip_routines' && Object.prototype.hasOwnProperty.call(request, 'webhooks') && this.apiVersion < 90) { fail('Update DGC for routines a service calls.'); return; }
    if(['get_pip_webhook','replace_pip_webhook_address','set_pip_webhook_signing','send_pip_webhook_test','get_webhook_reach','set_webhook_reach'].includes(request.type) && this.apiVersion < 90) { fail('Update DGC for routines a service calls.'); return; }
    // API 64: a Pip your app's code keeps from a template, and the change its template asks for.
    if(['list_pip_templates','decide_pip_template_change'].includes(request.type) && this.apiVersion < 64) { fail('Update DGC to see what your code keeps for a Pip.'); return; }
    // API 67: where a Pip's reports go (also its own document or sheet) and the dashboards it refreshes after each run.
    if(['get_pip_artifacts','set_pip_artifacts'].includes(request.type) && this.apiVersion < 67) { fail('Update DGC to keep a Pip\'s reports as a document and have it refresh dashboards.'); return; }
    if(request.type === 'get_pip_usage' && this.apiVersion < 41) { fail('Update DGC for Pip usage.'); return; }
    if(['get_pips_desktop_notifications','set_pips_desktop_notifications'].includes(request.type) && this.apiVersion < 41) { fail('Update DGC for desktop notifications.'); return; }
    // API 75 (0.52, P1): whether a Pip at Do it all may pay by itself, at most three a day. Off by default.
    if(['get_pips_payments','set_pips_payments','set_pip_paying'].includes(request.type) && this.apiVersion < 75) { fail('Update DGC to let Pips pay.'); return; }
    // API 96 (0.52, agreed 13 Nov): a Pip's daily dollar limit, count and sites (the 3-a-day count is retired); the
    // "Knows about you" switch (Q8); and what a Pip's computer sent to the web (leak guard 4).
    if(['set_pip_pay_limits'].includes(request.type) && this.apiVersion < 96) { fail('Update DGC to set how much a Pip may pay.'); return; }
    if(['set_pip_knows_you','list_pip_sent'].includes(request.type) && this.apiVersion < 96) { fail('Update DGC for this.'); return; }
    // API 76 (0.52, Pips package 6): a backup model for Pips.
    if(['get_pips_backup','set_pips_backup','get_pip_backup','set_pip_backup'].includes(request.type) && this.apiVersion < 76) { fail('Update DGC for a backup model.'); return; }
    // API 77 (0.52, D6): Undo on a change a Personal Pip made about itself at once, in a turn you started.
    if(request.type === 'undo_pip_change' && this.apiVersion < 77) { fail('Update DGC to undo a Pip\u2019s own change.'); return; }
    if(['get_pips_keep_running','set_pips_keep_running'].includes(request.type) && this.apiVersion < 41) { fail('Update DGC to keep Pips running.'); return; }
    if(['list_pip_starters','propose_starter_pip'].includes(request.type) && this.apiVersion < 41) { fail('Update DGC for starter Pips.'); return; }
    if(['get_pip_digest','mark_pip_digest_seen','get_pip_notify_settings','set_pip_notify_settings','get_pip_outcomes'].includes(request.type) && this.apiVersion < 41) { fail('Update DGC for the Pips digest and notification settings.'); return; }
    if(request.type==='notify_pip_setup'&&!this.backgroundSetup){fail('It’s created. Reload the window so the chat hears about it.');return;}
    let command: any;
    if (request.type === 'pips_enable' && typeof request.enabled === 'boolean') {
      command = {type: 'pips_enable', enabled: request.enabled, request_id: requestId};
    } else if (request.type === 'pips_runtime' && ['start', 'resume'].includes(request.action)) {
      command = {type: 'pips_runtime', action: request.action, request_id: requestId};
    } else if (commands.has(request.type)) {
      const nested = {...request, request_id: requestId};
      const maxBytes = ['save_pip_key','prepare_pip_connector_draft','propose_pip_connector_action','propose_pip_handoff', 'propose_pip_artifact_handoff', 'propose_pip_personal_handoff', 'propose_pip_app_action','propose_pip_calendar_action','prepare_pip_message_draft','prepare_pip_calendar_draft'].includes(request.type) ? 32768
        // A message to a Pip can be up to 256 KB from API 79 (Limits for everyone): as much as DGC's own request limit.
        : request.type === 'send_pip_message' && this.apiVersion >= 79 ? 2 * 1024 * 1024
        // A question card's answers (Pips API 106): up to four, each with up to 4,096 characters of your own words.
        : request.type === 'answer_pip_questions' ? 64 * 1024
        // pips-18: what a Grok bot wrote is up to 64 KiB of text (checked above), more once its line ends are escaped.
        : request.type === 'import_pip_source' ? 6 * IMPORT_REPLY_BYTES + 4096 : 16384;
      // A message's images, or a file added to a Pip's computer, travel outside the request budget,
      // bounded on their own (2 MB of data); every other field keeps the budget.
      const fileData = request.type === 'add_pip_computer_file' && Object.prototype.hasOwnProperty.call(request, 'data') ? request.data : undefined;
      if (fileData !== undefined && (typeof fileData !== 'string' || !fileData.startsWith('data:') || !fileData.slice(0, 200).includes(';base64,') || !/^[\x00-\x7f]*$/.test(fileData) || fileData.length > MAX_IMAGE_URI_CHARS)) { fail('Add a file of 2 MB or less. Nothing was sent.'); return; }
      // The spool's names come from this host alone (API 52); a view never names files in it, nor asks for a kept path.
      if (request.type === 'send_pip_message' && ['spooled_images', 'spooled_files'].some(key => Object.prototype.hasOwnProperty.call(request, key))) {
        fail(this.apiVersion < 52 ? 'Update DGC to send bigger photos and files to a Pip.' : 'Add photos and files with the message box.'); return;
      }
      if (request.type === 'get_pip_message_image' && Object.prototype.hasOwnProperty.call(request, 'as_file')) {
        fail(this.apiVersion < 52 ? 'Update DGC to open a Pip chat’s photos.' : 'Choose a photo in the chat.'); return;
      }
      if (request.type === 'get_pip_message_image' && this.apiVersion >= 52 && typeof request.pip_id === 'string' && typeof request.message_id === 'string'
        && Number.isSafeInteger(request.index)) {
        // A photo can be 8 MiB, which no frame carries as a data URI: the host reads the kept file itself.
        this.pending.set(requestId, { client: message.id, command: request.type, at: Date.now(), surface,
          keptImage: { pip: request.pip_id, message: request.message_id, index: request.index, generation: this.generation } });
        if (!this.send({ type: 'pips_control', request: { ...nested, as_file: true } }, this.backendIdentity)) { this.pending.delete(requestId); fail('DGC couldn’t read that photo.'); }
        return;
      }
      if (request.type === 'send_pip_message' && this.apiVersion >= 52 && this.spoolDir
        && ['images', 'files'].some(key => Object.prototype.hasOwnProperty.call(request, key))) {
        const problem = this.spoolProblem(request.images, request.files);
        if (problem) { fail(problem); return; }
        const { images: _images, files: _files, ...small } = nested;
        if (Buffer.byteLength(JSON.stringify(small), 'utf8') > maxBytes) { fail(`This request exceeds the ${maxBytes / 1024} KiB limit. Nothing was sent.`); return; }
        void this.sendSpooled(message.id, surface, request, requestId);
        return;
      }
      const images = request.type === 'send_pip_message' && Object.prototype.hasOwnProperty.call(request, 'images') ? request.images : undefined;
      if (images !== undefined && (!Array.isArray(images) || images.length < 1 || images.length > 4 || images.some((i: unknown) => typeof i !== 'string' || !i.startsWith('data:image/') || !/^[\x00-\x7f]*$/.test(i))
        || images.reduce((n: number, i: string) => n + i.length, 0) > MAX_IMAGE_URI_CHARS)) { fail('Send up to 4 images, 2 MB in all. Nothing was sent.'); return; }
      const files = request.type === 'send_pip_message' && Object.prototype.hasOwnProperty.call(request, 'files') ? request.files : undefined;
      if (files !== undefined && (!Array.isArray(files) || files.length < 1 || files.length > 4 || files.some((f: any) => !f || typeof f !== 'object' || Object.keys(f).sort().join() !== 'data,name'
        || typeof f.name !== 'string' || !f.name.trim() || f.name.length > 255 || /[\/\\"\u0000-\u001f]/.test(f.name)
        || typeof f.data !== 'string' || !f.data.startsWith('data:') || !f.data.slice(0, 200).includes(';base64,') || !/^[\x00-\x7f]*$/.test(f.data)))) { fail('Send up to 4 files, 2 MB in all. Nothing was sent.'); return; }
      const bulk = (images || []).reduce((n: number, i: string) => n + i.length, 0) + (files || []).reduce((n: number, f: any) => n + f.data.length, 0) + (typeof fileData === 'string' ? fileData.length : 0);
      if (bulk > MAX_IMAGE_URI_CHARS) { fail('Send at most 2 MB of images and files with one message. Nothing was sent.'); return; }
      const sized = images === undefined && fileData === undefined && files === undefined ? nested : {...nested, images: undefined, data: undefined, files: undefined};
      if (Buffer.byteLength(JSON.stringify(sized), 'utf8') > maxBytes) { fail(`This request exceeds the ${maxBytes / 1024} KiB limit. Nothing was sent.`); return; }
      command = {type: 'pips_control', request: nested};
    } else { fail('Unknown Pips command.'); return; }
    const newsDismiss = request.type === 'mark_pip_news_seen' && Array.isArray(request.pip_ids)
      && request.pip_ids.every((id: unknown) => typeof id === 'string' && /^pip_[0-9a-f]{32}$/.test(id))
      && typeof request.until === 'string' && Number.isFinite(Date.parse(request.until))
      ? { pipIds: request.pip_ids as string[], until: request.until as string } : undefined;
    // (A code may wait for the Pip's computer to open before it is typed: its answer is kept a while longer.)
    this.pending.set(requestId, {client: message.id, command: request.type, at: Date.now() + (request.type === 'fill_pip_code' ? 45000 : request.type === 'set_pips_keep_running' ? 100000 : 0), surface, newsDismiss,
      ...(['send_pip_message', 'answer_pip_questions'].includes(request.type) && typeof request.pip_id === 'string' && /^pip_[A-Za-z0-9]{1,64}$/.test(request.pip_id) ? { pip: request.pip_id } : {})});
    if (!this.send(command, this.backendIdentity)) { this.pending.delete(requestId); fail('DGC couldn’t send that. Refresh to see whether it worked before trying again.'); }
  }
  dispose(): void { PipsEditor.bridges.delete(this); this.pending.clear(); this.embeddedPost = undefined; this.panel?.dispose(); for (const { panel } of [...this.computers.values()]) panel.dispose(); for (const { panel } of [...this.chats.values()]) panel.dispose(); }
}
