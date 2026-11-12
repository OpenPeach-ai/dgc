import * as vscode from 'vscode';
import { MIC_MESSAGES, SPEAK_MESSAGES, type Dictation, type DictationOwner, type ReadAloud } from './voice';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import type { Artifacts } from './artifacts';
import { mcpAppsHost } from './mcpApps';
import { handleVideoMessage, VIDEO_MESSAGES } from './videoHost';
import { displayMentions, workspaceFiles } from './mentionsHost';
import { APP_ID, appLogoData } from './pluginLogos';
import { markIcon } from './dock';
import marks from '../media/shared/marks.js';

/** What a Pip's page uses of the artifacts (artifacts.ts): the person's dashboards, and opening one. */
type PipArtifactsHub = Pick<Artifacts, 'list' | 'open' | 'offers'>;
const ARTIFACT_ID = /^ar_[a-f0-9]{16}$/;

// (The last six: webhooks in, fully local, Pips API 90: a routine's own secret address, and how calls reach this computer.)
const commands = new Set(['get_pip_import_prompt','import_pip_source','get_pip_skills','set_pip_skill','get_pip_apps','set_pip_app','add_pip_app_account','list_pip_conversations','create_pip_conversation','rename_pip_conversation','archive_pip_conversation','add_pip_computer','list_pip_keys','save_pip_key','decline_pip_key','remove_pip_key','list_pip_flows','get_pip_flow','create_pip_flow','set_pip_flow','get_pip_artifacts','set_pip_artifacts','list_pip_run_fixes','list_pip_templates','decide_pip_template_change','list_app_events','list_apps','accept_app_update','list_pip_borrows','allow_pip_borrow','decline_pip_borrow','stop_pip_borrow','get_pip_level','set_pip_level','get_pip_working_notes','set_pip_working_notes','list_pip_daily_log','list_pip_logins','save_pip_login','remove_pip_login','grant_pip_login','get_pip_computer_apps','set_pip_computer_apps','get_pip_eyes','set_pip_eyes','list_pip_run_posts','list_pip_unread','mark_pip_read','check_pip_source','get_pip_run_source','mark_pip_news_seen','set_pip_chat_options','set_plugin_permission','list_pip_sites','set_pip_careful','forget_pip_site','list_pip_notes','add_pip_note','forget_pip_note','list_pip_attention','get_pips_limit','set_pips_limit','list_pip_reply_stats','get_pip_chat_context','list_pip_plugins','allow_pip_plugin','decline_pip_plugin','list_pip_plugin_uses','list_pip_routines','add_pip_routine','update_pip_routine','delete_pip_routine','decide_pip_routine','set_pip_profile','list_pip_shared','get_pip_computers','update_pip_computers','reset_pip_computer','list_pip_apps','finish_pip_computer_check','list_pip_app_links','start_pip_app_link','check_pip_app_link','decline_pip_app_link','disconnect_pip_app_link','get_pip_computer_desktop','list_pip_computer_files','read_pip_computer_file','add_pip_computer_file','remove_pip_computer_file','run_pip_computer_command','list_pip_computer_terminal','get_pip_message_image','introduce_pip','always_allow_pip_computer_action','get_pip_computer','list_pip_computer_actions','decide_pip_computer_action','get_pip_computer_frame','list_pip_computer_frames','stop_pip_computer','open_pip_computer','use_pip_computer_view','always_allow_pip_app_action','list_pip_action_grants','revoke_pip_action_grant','set_pip_feedback','list_pip_feedback','export_pip','get_pip_usage','get_pips_backup','set_pips_backup','get_pip_backup','set_pip_backup','undo_pip_change','get_pips_payments','set_pips_payments','set_pip_paying','get_pips_desktop_notifications','set_pips_desktop_notifications','get_pips_keep_running','set_pips_keep_running','list_pip_starters','propose_starter_pip','get_pip_digest','mark_pip_digest_seen','get_pip_notify_settings','set_pip_notify_settings','get_pip_outcomes','get_pip_connector_draft','list_pip_connector_drafts','prepare_pip_connector_draft','dismiss_pip_connector_draft','inspect_pip_connector_actions','propose_pip_connector_action','get_pip_calendar_draft','list_pip_calendar_drafts','prepare_pip_calendar_draft','dismiss_pip_calendar_draft','inspect_pip_calendar_connection','propose_pip_calendar_action','get_pip_message_draft','list_pip_message_drafts','prepare_pip_message_draft','dismiss_pip_message_draft','inspect_pip_send_connection', 'propose_pip_app_action', 'get_pip_app_action', 'list_pip_app_actions', 'accept_pip_app_action', 'reject_pip_app_action', 'propose_pip_personal_handoff', 'list_pip_accounts', 'list_pip_connections', 'inspect_pip_connection', 'notify_pip_setup', 'revise_pip_setup', 'list_pip_setups', 'get_pip_setup', 'accept_pip_setup', 'reject_pip_setup', 'get_pip_statement_anchor', 'record_pip_statement', 'revoke_pip_statement', 'list_pip_statements', 'list_workspace_execution_receipts', 'get_workspace_execution_receipt', 'record_workspace_execution_context', 'archive_pip', 'restore_pip', 'delete_archived_pip', 'get_pip_exception_source', 'record_pip_exception', 'revoke_pip_exception', 'list_pip_memories', 'list_pip_notifications', 'mark_pip_notification_read', 'list_workspace_sessions', 'inspect_workspace_session_outcome', 'propose_workspace_session_outcome', 'get_workspace_session_outcome', 'list_workspace_session_outcomes', 'accept_workspace_session_outcome', 'reject_workspace_session_outcome', 'list_pip_types', 'list_pip_models', 'list_pip_messages', 'send_pip_message', 'list_workspaces', 'list_pips', 'create_pip', 'get_pip', 'get_pip_proposal', 'list_pip_adaptations', 'run_pip', 'list_pip_runs', 'get_pip_run', 'list_pip_run_activity', 'pause_pip', 'resume_pip', 'cancel_pip_run', 'propose_pip_update', 'accept_pip_update', 'reject_pip_update', 'list_pip_versions', 'list_pip_approvals', 'list_pip_checkpoints', 'review_pip_finding', 'review_pip_execution', 'get_pip_execution', 'propose_pip_handoff', 'propose_pip_artifact_handoff', 'get_pip_handoff', 'list_pip_handoffs', 'accept_pip_handoff', 'reject_pip_handoff', 'get_pip_runner', 'stop_pips', 'get_workspace_context', 'record_workspace_context', 'archive_workspace_context', 'accept_pip_finding', 'accept_pip_execution_context', 'rename_pip_computer', 'set_pip_computer_screen', 'get_pip_webhook', 'replace_pip_webhook_address', 'set_pip_webhook_signing', 'send_pip_webhook_test', 'get_webhook_reach', 'set_webhook_reach']);
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
const KEPT_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
const attr = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
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
/** pips-12: a switch per skill on a Pip's page, and folders in the Personal list (Pips API 88). get_pip_skills {pip_id}
 *  lists its skills, set_pip_skill {pip_id, skill, on} switches one; a Pip's folder is set_pip_profile's changes.group.
 *  Why a request is refused, or '' when it may go: an older DGC is never sent one; a skill is named as DGC names it; on
 *  is true or false; a folder's name is one line of up to 40 characters. */
const PIP_SKILL = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export function pipTeamsRefusal(request: any, apiVersion: number): string {
  if (['get_pip_skills', 'set_pip_skill'].includes(request?.type)) {
    if (apiVersion < 88) return 'Update DGC to choose the skills a Pip can use.';
    if (request.type === 'set_pip_skill' && (typeof request.skill !== 'string' || !PIP_SKILL.test(request.skill))) return 'Choose one of the skills on this Pip’s page.';
    if (request.type === 'set_pip_skill' && typeof request.on !== 'boolean') return 'Switch a skill on or off.';
    return '';
  }
  if (request?.type === 'set_pip_profile' && request.changes && typeof request.changes === 'object' && Object.prototype.hasOwnProperty.call(request.changes, 'group')) {
    if (apiVersion < 88) return 'Update DGC to put Pips in folders.';
    const group = request.changes.group;
    if (typeof group !== 'string' || [...group.trim()].length > 40 || /[\u0000-\u001f\u007f]/.test(group)) return 'A folder’s name is one line of up to 40 characters.';
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

export function pipsDocument(scriptUri = '', styleUri = '', cspSource = '', markdownUri = '', cardsUri = '', cardsStyleUri = '', videoUri = '', codiconUri = ''): string {
  // frame-src: only a plugin's card (MCP Apps), at the loopback address DGC's backend serves it from.
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data:; style-src ${attr(cspSource)} 'unsafe-inline'; script-src ${attr(cspSource)};${codiconUri ? ` font-src ${attr(cspSource)};` : ''}${videoUri ? ' media-src blob:;' : ''}${cardsUri ? ' frame-src http://127.0.0.1:* http://localhost:*;' : ''}">${codiconUri ? `<link rel="stylesheet" href="${attr(codiconUri)}">` : ''}<link rel="stylesheet" href="${attr(styleUri)}">${cardsStyleUri ? `<link rel="stylesheet" href="${attr(cardsStyleUri)}">` : ''}<title>DGC Pips</title></head><body><main id="app">${PIPS_BOOT_MARK}</main><div id="review-root"></div>${cardsUri ? `<script src="${attr(cardsUri)}"></script>` : ''}${videoUri ? `<script src="${attr(videoUri)}"></script>` : ''}${markdownUri ? `<script src="${attr(markdownUri)}"></script>` : ''}<script src="${attr(scriptUri)}"></script></body></html>`;
}

/** A Pip's computer in an editor tab: its Browser, Files and Terminal. */
export function computerDocument(scriptUri = '', styleUri = '', cspSource = '', title = 'Computer'): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data:; style-src ${attr(cspSource)} 'unsafe-inline'; script-src ${attr(cspSource)};"><link rel="stylesheet" href="${attr(styleUri)}"><title>${attr(title)}</title></head><body><main id="app"><p role="status">Connecting to local DGC…</p></main><script type="module" src="${attr(scriptUri)}"></script></body></html>`;
}
/** What a computer tab may ask for: its own Pip's computer, nothing else. */
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
  private pending = new Map<string, { client: string; command: string; at: number; surface?: string; document?: { run: string; save: boolean; generation: number }; exportFile?: { generation: number }; exportTeam?: { generation: number }; keptImage?: { pip: string; message: string; index: number; generation: number }; spooled?: string[]; newsDismiss?: { pipIds: string[]; until: string } }>();
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
  private savedProviders?: { list: () => Promise<unknown[]>; save: (id: string, model: string) => Promise<void>; none: () => boolean };
  private pluginLogo?: (plugin: string) => string;
  usePluginLogos(lookup: (plugin: string) => string): void { this.pluginLogo = lookup; }
  /** Providers saved in Settings: the host lists them for a Pip's model menus, and saves one (with its key, which never
   *  comes here) before a Pip is set to it. */
  useSavedProviders(list: () => Promise<unknown[]>, save: (id: string, model: string) => Promise<void>, none: () => boolean = () => false): void { this.savedProviders = { list, save, none }; }
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
  dockChanged(): void { if (this.dock) this.post(this.dock.state()); }
  /** Settings changed Pictures in replies: the page follows it. */
  picturesSetting(message: any): void { this.post(message); }
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
  setupChanged(setupId: string): void { this.post({ type: 'pipSetupChanged', setup_id: setupId }); }
  private profileChangeNotice?: () => void;
  useProfileChanged(notify: () => void): void { this.profileChangeNotice = notify; }
  profileChanged(): void { this.post({ type: 'pipsProfileChanged' }); }
  /** A video's Stop from a Pip's chat: the window's backend (videos_stop), set by the panel. */
  videoStop?: (job: string) => Promise<Record<string, unknown> | undefined>;
  /** A Pip reply's running video: the window's backend polls (or watches) it, so one a restart left on disk ends. */
  videoFollow?: (job: string) => void;
  constructor(private readonly extensionUri: vscode.Uri, private readonly send: (message: any, backendIdentity?: object) => boolean, private readonly connect: () => void, private readonly requireGeneration = false) {}
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
    if (this.embeddedPost) this.embeddedPost(message);
    else this.panel?.webview.postMessage(message);
  }
  /** Settings saved, or the Router's settings changed: what a Pip on Default runs on may have changed with them (Pips run
   *  on, the Router on or off, its Pip systems), so an open Pips page reads list_pip_models again. */
  modelsChanged(): void { this.post({ type: 'pipsModelsChanged' }); }
  /** A Pip was marked read somewhere else: an open Pips page reads its unread counts again. */
  unreadChanged(): void { this.post({ type: 'pipsUnreadChanged' }); }
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
  /** Save to this computer… on a file in a computer tab's Files (Pips API 87): the user picks the place in VS Code's own
   *  save dialog and DGC copies the file there, whatever its size. The page says which file in Files and nothing else. */
  private async saveComputerFileAs(surface: string, computer: { pip: ComputerPip }, message: any): Promise<void> {
    const done = (ok: boolean, extra: Record<string, unknown> = {}) => this.post({ type: 'pipComputerSavedAs', ok, ...extra }, surface);
    if (this.apiVersion < COMPUTER_COPY_API) { done(false, { error: 'Update DGC to save files over 2 MB.' }); return; }
    if (!filesPath(message.path) || !message.path) { done(false, { error: 'Choose a file in this computer’s Files.' }); return; }
    if (this.computerCopying.has(surface)) return;
    this.computerCopying.add(surface);
    try {
      const last = message.path.split('/').pop() || '', name = /^[^/\\\0]{1,255}$/.test(last) ? last : 'file';
      const target = this.pickedPath(await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir()), name), saveLabel: 'Save' }) ?? undefined);
      if (!target) { done(false, { cancelled: true }); return; }
      const result = await this.computerCopy('copy_pip_computer_file_out', { pip_id: computer.pip.id, path: message.path, target });
      done(true, { name: (typeof result.target === 'string' && result.target ? result.target : target).split(/[\\/]/).pop()!.slice(0, 255) });
    } catch (error) {
      done(false, { error: error instanceof Error && error.message ? error.message : 'Not saved.' });
    } finally { this.computerCopying.delete(surface); }
  }
  /** Save a file from a Pip's computer where the user chooses. The bytes came from its own read. */
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
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir()), name), saveLabel: 'Save' });
      if (!target) { this.post({ type: 'pipComputerSaved', ok: false, error: 'Not saved.' }, surface); return; }
      await vscode.workspace.fs.writeFile(target, data);
      this.post({ type: 'pipComputerSaved', ok: true, name: target.path.split('/').pop() }, surface);
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
    panel.onDidDispose(() => { this.panel = undefined; this.pending.clear(); this.dictation?.().release(this.mic); this.readAloud?.().release(this.mic); });
    panel.onDidChangeViewState(() => panel.webview.postMessage({ type: 'pipsVisibility', visible: panel.visible }));
    panel.webview.onDidReceiveMessage(message => this.receive(message));
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', name)).toString();
    const media = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name)).toString();
    panel.webview.html = pipsDocument(asset('pips.js'), asset('pips.css'), panel.webview.cspSource, asset('markdown.js'),
                                      media('mcpApps.js'), media('mcpApps.css'), media('videoPlayer.js'), media('codicon.css'));
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
    this.spoolDir = capabilities?.image_spool === true && typeof capabilities?.image_spool_dir === 'string' ? capabilities.image_spool_dir : '';
    this.generation++;
    this.pending.clear();
    this.endComputerCopies();
    this.connectFailed = false;
    this.state = { connected: true, supported: capabilities?.pips_supported === true && capabilities?.pips_api_version >= 9, enabled: capabilities?.pips_enabled === true };
    this.publish();
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
    const connection = { type: 'pipsConnection', generation: this.generation, apiVersion: this.apiVersion, backgroundSetup:this.backgroundSetup, displayMentions:this.displayMentions, ...(folder === undefined ? {} : { folder }), ...(this.connectFailed ? { failed: true } : {}), ...this.state };
    this.post(connection);
    for (const id of this.computers.keys()) this.post(connection, 'computer:' + id);
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
      void this.openResultDocument(owner.client, owner.document, event.result?.run);
      return true;
    }
    if (owner.exportFile && event.type === 'pips_result' && event.ok === true) {
      void this.openExport(owner.client, owner.exportFile.generation, event.result);
      return true;
    }
    if (owner.exportTeam && event.type === 'pips_result' && event.ok === true) {
      void this.saveTeam(owner.client, owner.exportTeam.generation, event.result);
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
      void this.savedProviders.list().catch(() => [] as unknown[]).then(providers =>
        this.post({ type: 'pipsReply', id: owner.client, ok: true, result: { ...event.result, providers, ...(this.savedProviders?.none() ? { no_provider: true } : {}) } }, owner.surface));
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
    if (owner.command === 'set_pip_profile' && event.type === 'pips_result' && event.ok === true) this.profileChangeNotice?.();
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
  private async openExport(client: string, generation: number, result: any): Promise<void> {
    try {
      if (generation !== this.generation || !this.state.connected) throw Error('The DGC connection changed. Export again.');
      const text = result?.text;
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 24576) throw Error('The shared Pip file is invalid.');
      const document = await vscode.workspace.openTextDocument({ language: 'json', content: text });
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
      await vscode.commands.executeCommand('workbench.action.files.saveAs', document.uri);
      const leftOut = Array.isArray(result?.document?.left_out) ? result.document.left_out.filter((x: any) => typeof x === 'string').slice(0, 8) : [];
      this.post({ type: 'pipsReply', id: client, ok: true, result: { opened: true, left_out: leftOut } });
    } catch (error) {
      this.post({ type: 'pipsReply', id: client, ok: false, error: { message: error instanceof Error ? error.message : 'Could not export the Pip.' } });
    }
  }
  /** The user picks a shared Pip file; the host reads it and the chat saves it as a setup card. */
  private async importFile(client: string): Promise<void> {
    const fail = (text: string) => this.post({ type: 'pipsReply', id: client, ok: false, error: { message: text } });
    try {
      const generation = this.generation;
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Import Pip', filters: { 'Shared Pip': ['json'] } });
      if (!picked || !picked.length) { this.post({ type: 'pipsReply', id: client, ok: true, result: { cancelled: true } }); return; }
      const bytes = await vscode.workspace.fs.readFile(picked[0]);
      if (bytes.byteLength > 24576) { fail('A shared Pip file is at most 24 KiB.'); return; }
      if (generation !== this.generation || !this.state.connected) { fail('The DGC connection changed. Import again.'); return; }
      const requestId = 'pips-editor-' + randomBytes(12).toString('hex');
      this.pending.set(requestId, { client, command: 'import_pip_document', at: Date.now() });
      if (!this.send({ type: 'pips_control', request: { type: 'import_pip_document', document: Buffer.from(bytes).toString('utf8'), request_id: requestId } }, this.backendIdentity)) {
        this.pending.delete(requestId); fail('DGC could not send the file. Nothing was saved.');
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Could not read the shared Pip file.');
    }
  }
  /** pips-12: a team's file is saved where the user chooses in the save dialog. The text came from DGC's own export; the
   *  page hears the file's name and what was left out, never where it is. */
  private async saveTeam(client: string, generation: number, result: any): Promise<void> {
    try {
      if (generation !== this.generation || !this.state.connected) throw Error('The DGC connection changed. Export again.');
      const text = result?.text, team = result?.document;
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > TEAM_FILE_BYTES || team?.format !== 'dgc-team' || typeof team.name !== 'string'
        || !Array.isArray(team.pips) || !team.pips.length || team.pips.length > TEAM_PIPS) throw Error('The team file is invalid.');
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir()), teamFileName(team.name)),
        saveLabel: 'Save team', filters: { 'DGC team': ['json'] } });
      if (!target) { this.post({ type: 'pipsReply', id: client, ok: true, result: { cancelled: true } }); return; }
      await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
      const leftOut: string[] = [];
      for (const pip of team.pips) for (const note of Array.isArray(pip?.left_out) ? pip.left_out : []) if (typeof note === 'string' && !leftOut.includes(note)) leftOut.push(note);
      this.post({ type: 'pipsReply', id: client, ok: true, result: { saved: true, file: String(target.path).split(/[\\/]/).pop() || teamFileName(team.name), name: team.name, count: team.pips.length, left_out: leftOut.slice(0, 8) } });
    } catch (error) {
      this.post({ type: 'pipsReply', id: client, ok: false, error: { message: error instanceof Error ? error.message : 'Could not export the team.' } });
    }
  }
  /** pips-12: the user picks a team file; the host reads it and the chat saves one setup card per Pip in it. */
  private async importTeamFile(client: string): Promise<void> {
    const fail = (text: string) => this.post({ type: 'pipsReply', id: client, ok: false, error: { message: text } });
    try {
      const generation = this.generation;
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Import team', filters: { 'DGC team': ['json'] } });
      if (!picked || !picked.length) { this.post({ type: 'pipsReply', id: client, ok: true, result: { cancelled: true } }); return; }
      const bytes = await vscode.workspace.fs.readFile(picked[0]);
      if (bytes.byteLength > TEAM_FILE_BYTES) { fail('A team file is at most 256 KiB.'); return; }
      if (generation !== this.generation || !this.state.connected) { fail('The DGC connection changed. Import again.'); return; }
      const requestId = 'pips-editor-' + randomBytes(12).toString('hex');
      this.pending.set(requestId, { client, command: 'import_pip_team', at: Date.now() });
      if (!this.send({ type: 'pips_control', request: { type: 'import_pip_team', document: Buffer.from(bytes).toString('utf8'), request_id: requestId } }, this.backendIdentity)) {
        this.pending.delete(requestId); fail('DGC could not send the file. Nothing was saved.');
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Could not read the team file.');
    }
  }
  private async openResultDocument(client: string, requested: { run: string; save: boolean; generation: number }, run: any): Promise<void> {
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
      this.post({type:'pipsReply', id:client, ok:true, result:{opened:true}});
    } catch (error) {
      this.post({type:'pipsReply', id:client, ok:false, error:{message:error instanceof Error ? error.message : 'Could not open the saved document.'}});
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
  /** Open a photo from a Pip's chat, the original, in an editor tab (one click on its thumbnail). With `save` (Download
   *  on a made file's row, pips-08) it asks where to save the original instead, under a name a person can read. */
  private async openPhoto(message: any): Promise<void> {
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
      if (message?.save === true) {
        const name = `Picture ${index + 1}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`;
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir()), name), saveLabel: 'Download' });
        if (!target) return;
        await vscode.workspace.fs.writeFile(target, Buffer.from(match[2], 'base64'));
        void vscode.window.showInformationMessage(`Saved ${target.path.split('/').pop()}.`);
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
  receive(message: any, surface = 'main'): void {
    const computer = surface.startsWith('computer:') ? this.computers.get(surface.slice(9)) : undefined;
    if (surface !== 'main' && !computer) return;
    if (VIDEO_MESSAGES.has(String(message?.type || '')) && !computer && this.panel) {
      // A Pip reply's video: its bytes and state from DGC's own folder, Open, Show in folder, and a Stop through this
      // window's backend (src/videoHost.ts).
      const panel = this.panel;
      void handleVideoMessage(message, reply => { void panel.webview.postMessage(reply); },
                              { stop: this.videoStop, follow: this.videoFollow });
      return;
    }
    if (message?.type === 'mcpApp' && !computer && this.panel) {
      // A plugin's card in a Pip's reply, in the Pips tab: what it asks goes to this window's backend (src/mcpApps.ts).
      const panel = this.panel;
      mcpAppsHost(this.extensionUri).fromPage(message, reply => { void panel.webview.postMessage(reply); },
                                              command => this.send(command, this.backendIdentity));
      return;
    }
    // (Copy too: a Pip tab's Copy puts its text on the clipboard as the side bar's does.)
    if (!computer && ['openFile', 'openExternal', 'openSettings', 'copy', 'codePreview'].includes(String(message?.type))) { this.pageActions?.(message); return; }
    if (message?.type === 'pipsSignIn' && !computer) { openEngineSignIn(String(message.engine || '')); return; }
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
    if (message?.type === 'pipsOpenPhoto' && !computer) { void this.openPhoto(message); return; }
    if (message?.type === 'pipsOpenArtifact' && !computer) {
      // A Pip's report document or sheet, or a dashboard it refreshes: in the artifact panel (a document in the editor).
      const id = String(message.id || ''), kind = String(message.artifactType || '');
      if (this.apiVersion >= 67 && ARTIFACT_ID.test(id) && ['doc', 'sheet', 'dashboard'].includes(kind)) this.artifacts?.()?.open(id, { type: kind });
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
    if (!computer && this.dock?.handle(message, (state) => this.post(state))) return;
    if (message?.type === 'pipsReady') {
      if (!computer && this.folds) this.post(this.folds.initial());
      if (!computer && this.dock) this.post(this.dock.state());
      if (computer) { this.post({ type: 'pipComputerInit', pip: computer.pip, desktop: this.desktopStream,
        ...(computer.number ? { number: computer.number, name: this.computerName(computer.pip.id, computer.number), numbers: this.desktopNumbers } : {}) }, surface); this.post({ type: 'pipsConnection', generation: this.generation, apiVersion: this.apiVersion, backgroundSetup:this.backgroundSetup, ...this.state }, surface); }
      else {
        this.publish();
        if (this.panelNavigation) this.post({ type: 'pipsNavigate', navigation: this.panelNavigation });
      }
      return;
    }
    if (message?.type === 'pipsReconnect') { this.pending.clear(); this.generation++; this.connectFailed = false; this.connect(); this.publish(); return; }
    if (message?.type !== 'pipsRequest' || typeof message.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(message.id)) return;
    const fail = (text: string) => this.post({ type: 'pipsReply', id: message.id, ok: false, error: { message: text } }, surface);
    // The copy commands carry a path on this computer: no page sends one, whichever page it is.
    if (COMPUTER_COPY_COMMANDS.has(message.request?.type)) { fail(this.apiVersion < COMPUTER_COPY_API ? 'Update DGC to copy files over 2 MB.' : 'Use Add file… or Save to this computer… in the computer’s Files.'); return; }
    // A computer tab is pinned to its own Pip and to the computer's commands.
    if (computer && (!COMPUTER_COMMANDS.has(message.request?.type) || (Object.prototype.hasOwnProperty.call(message.request, 'pip_id') && message.request.pip_id !== computer.pip.id))) { fail('This tab only uses this Pip\'s computer.'); return; }
    // And to its own one of them: a tab says no other computer's number.
    if (computer && Object.prototype.hasOwnProperty.call(message.request, 'number') && message.request.number !== computer.number) { fail('This tab only uses this computer.'); return; }
    if (this.requireGeneration && message.generation !== this.generation) { fail('This view is from an earlier connection. Refresh and try again.'); return; }
    if (!this.state.connected || !this.state.supported) { fail('Pips aren’t available. Update DGC, then reconnect.'); return; }
    for (const [id, item] of this.pending) if (Date.now() - item.at > 60000) this.pending.delete(id);
    if (this.pending.size >= 64) { fail('DGC is busy. Reconnect and try again.'); return; }
    const request = message.request;
    if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.type !== 'string') return;
    // No provider yet: a Pip's hello has nothing to run on. Nothing is queued; the Pip says hello once one is saved.
    if (request.type === 'introduce_pip' && this.savedProviders?.none()) {
      this.post({ type: 'pipsReply', id: message.id, ok: true, result: { no_provider: true } }, surface);
      return;
    }
    // A Pip set to a saved provider: the host saves that provider first, so the choice's check and its runs find it.
    // A Pip's fallback on a saved provider (D14) is saved the same way.
    const chosen = request.model_choice ?? request.changes?.model_choice
      ?? (request.type === 'set_pip_backup' && typeof request.provider === 'string' && request.provider && request.model
        ? { mode: 'provider', provider: request.provider, model: request.model } : undefined);
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
        void this.importFile(message.id); return;
      }
      if (Object.keys(request).some(key => !['type','pip_id'].includes(key)) || typeof request.pip_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.pip_id)) { fail('Choose a Pip to export.'); return; }
      const requestId = 'pips-export-' + randomBytes(12).toString('hex');
      this.pending.set(requestId, { client: message.id, command: 'export_pip', at: Date.now(), exportFile: { generation: this.generation } });
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
        void this.importTeamFile(message.id); return;
      }
      const ids = request.pip_ids;
      if (Object.keys(request).some(key => !['type','pip_ids','name'].includes(key)) || !Array.isArray(ids) || !ids.length || ids.length > TEAM_PIPS
        || ids.some((id: unknown) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) || new Set(ids).size !== ids.length) { fail('Choose 1 to 20 Pips to share as a team.'); return; }
      if (typeof request.name !== 'string' || [...request.name].length > 80 || /[\u0000-\u001f\u007f]/.test(request.name)) { fail('A team’s name is one line of up to 80 characters.'); return; }
      const requestId = 'pips-export-' + randomBytes(12).toString('hex');
      this.pending.set(requestId, { client: message.id, command: 'export_pip_team', at: Date.now(), exportTeam: { generation: this.generation } });
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
      this.pending.set(requestId, {client:message.id, command:'get_pip_run', at:Date.now(), document:{run:request.run_id, save:request.save, generation:this.generation}});
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
      const marks = this.displayMentions ? displayMentions(request.display_mentions) : undefined;
      if (marks) request.display_mentions = marks; else delete request.display_mentions;
    }
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
    this.pending.set(requestId, {client: message.id, command: request.type, at: Date.now(), surface, newsDismiss});
    if (!this.send(command, this.backendIdentity)) { this.pending.delete(requestId); fail('DGC couldn’t send that. Refresh to see whether it worked before trying again.'); }
  }
  dispose(): void { this.pending.clear(); this.embeddedPost = undefined; this.panel?.dispose(); for (const { panel } of [...this.computers.values()]) panel.dispose(); }
}
