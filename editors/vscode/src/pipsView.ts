import * as vscode from 'vscode';
import { MIC_MESSAGES, SPEAK_MESSAGES, type Dictation, type DictationOwner, type ReadAloud } from './voice';
import { randomBytes } from 'crypto';
import { homedir } from 'os';

const commands = new Set(['list_pip_templates','decide_pip_template_change','list_app_events','list_apps','accept_app_update','list_pip_borrows','allow_pip_borrow','decline_pip_borrow','stop_pip_borrow','get_pip_level','set_pip_level','get_pip_working_notes','set_pip_working_notes','list_pip_daily_log','list_pip_logins','save_pip_login','remove_pip_login','grant_pip_login','get_pip_computer_apps','set_pip_computer_apps','get_pip_eyes','set_pip_eyes','list_pip_run_posts','check_pip_source','get_pip_run_source','mark_pip_news_seen','set_pip_chat_options','set_plugin_permission','list_pip_sites','set_pip_careful','forget_pip_site','list_pip_notes','add_pip_note','forget_pip_note','list_pip_attention','get_pips_limit','set_pips_limit','list_pip_reply_stats','get_pip_chat_context','list_pip_plugins','allow_pip_plugin','decline_pip_plugin','list_pip_plugin_uses','list_pip_routines','add_pip_routine','update_pip_routine','delete_pip_routine','decide_pip_routine','set_pip_profile','list_pip_shared','get_pip_computers','update_pip_computers','reset_pip_computer','list_pip_apps','finish_pip_computer_check','list_pip_app_links','start_pip_app_link','check_pip_app_link','decline_pip_app_link','disconnect_pip_app_link','get_pip_computer_desktop','list_pip_computer_files','read_pip_computer_file','add_pip_computer_file','remove_pip_computer_file','run_pip_computer_command','list_pip_computer_terminal','get_pip_message_image','introduce_pip','always_allow_pip_computer_action','get_pip_computer','list_pip_computer_actions','decide_pip_computer_action','get_pip_computer_frame','list_pip_computer_frames','stop_pip_computer','open_pip_computer','use_pip_computer_view','always_allow_pip_app_action','list_pip_action_grants','revoke_pip_action_grant','set_pip_feedback','list_pip_feedback','export_pip','get_pip_usage','get_pips_desktop_notifications','set_pips_desktop_notifications','get_pips_keep_running','set_pips_keep_running','list_pip_starters','propose_starter_pip','get_pip_digest','mark_pip_digest_seen','get_pip_notify_settings','set_pip_notify_settings','get_pip_outcomes','get_pip_connector_draft','list_pip_connector_drafts','prepare_pip_connector_draft','dismiss_pip_connector_draft','inspect_pip_connector_actions','propose_pip_connector_action','get_pip_calendar_draft','list_pip_calendar_drafts','prepare_pip_calendar_draft','dismiss_pip_calendar_draft','inspect_pip_calendar_connection','propose_pip_calendar_action','get_pip_message_draft','list_pip_message_drafts','prepare_pip_message_draft','dismiss_pip_message_draft','inspect_pip_send_connection', 'propose_pip_app_action', 'get_pip_app_action', 'list_pip_app_actions', 'accept_pip_app_action', 'reject_pip_app_action', 'propose_pip_personal_handoff', 'list_pip_accounts', 'list_pip_connections', 'inspect_pip_connection', 'notify_pip_setup', 'revise_pip_setup', 'list_pip_setups', 'get_pip_setup', 'accept_pip_setup', 'reject_pip_setup', 'get_pip_statement_anchor', 'record_pip_statement', 'revoke_pip_statement', 'list_pip_statements', 'list_workspace_execution_receipts', 'get_workspace_execution_receipt', 'record_workspace_execution_context', 'archive_pip', 'restore_pip', 'get_pip_exception_source', 'record_pip_exception', 'revoke_pip_exception', 'list_pip_memories', 'list_pip_notifications', 'mark_pip_notification_read', 'list_workspace_sessions', 'inspect_workspace_session_outcome', 'propose_workspace_session_outcome', 'get_workspace_session_outcome', 'list_workspace_session_outcomes', 'accept_workspace_session_outcome', 'reject_workspace_session_outcome', 'list_pip_types', 'list_pip_models', 'list_pip_messages', 'send_pip_message', 'list_workspaces', 'list_pips', 'create_pip', 'get_pip', 'get_pip_proposal', 'list_pip_adaptations', 'run_pip', 'list_pip_runs', 'get_pip_run', 'list_pip_run_activity', 'pause_pip', 'resume_pip', 'cancel_pip_run', 'propose_pip_update', 'accept_pip_update', 'reject_pip_update', 'list_pip_versions', 'list_pip_approvals', 'list_pip_checkpoints', 'review_pip_finding', 'review_pip_execution', 'get_pip_execution', 'propose_pip_handoff', 'propose_pip_artifact_handoff', 'get_pip_handoff', 'list_pip_handoffs', 'accept_pip_handoff', 'reject_pip_handoff', 'get_pip_runner', 'stop_pips', 'get_workspace_context', 'record_workspace_context', 'archive_workspace_context', 'accept_pip_finding', 'accept_pip_execution_context']);
/** Images sent with a Pip message, as data URIs: 2 MiB of image, base64, plus headers. */
const MAX_IMAGE_URI_CHARS = 2_800_000;
/** Pips API 52: photos and files go the Work chat's way. The host writes them into the backend's spool
 *  (ready.capabilities.image_spool_dir) and sends their names, so the 4 MiB command frame no longer caps
 *  them: 8 MiB a photo and 32 MiB of photos a message (no four-photo cap; 64 is the request's own bound),
 *  and the Work chat's document limits for files (16 MiB a document, 1 MiB a text or code file, 32 MiB). */
const MiB = 1024 * 1024;
const SPOOL_PHOTO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/heic': 'heic', 'image/heif': 'heif' };
const MAX_SPOOLED_PHOTOS = 64, MAX_PHOTO_BYTES = 8 * MiB, MAX_PHOTOS_BYTES = 32 * MiB;
const MAX_SPOOLED_FILES = 16, MAX_DOCUMENT_BYTES = 16 * MiB, MAX_TEXT_FILE_BYTES = MiB, MAX_FILES_BYTES = 32 * MiB;
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.rtf']);
const PHOTO_LIMITS = 'Send photos of up to 8 MB each, 32 MB in all.';
const FILE_LIMITS = 'Send up to 16 files: documents up to 16 MB, text and code up to 1 MB, 32 MB in all.';
const DATA_URI = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i;
const decodedBytes = (b64: string) => Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
/** A Pip chat's kept photo: <state>/chat_images/<pip_id>/<sha256>.<ext>, as the backend names it. */
const KEPT_PHOTO = /^[0-9a-f]{64}\.(png|jpg|gif|webp|bmp)$/;
const KEPT_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
const attr = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function pipsDocument(scriptUri = '', styleUri = '', cspSource = ''): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data:; style-src ${attr(cspSource)} 'unsafe-inline'; script-src ${attr(cspSource)};"><link rel="stylesheet" href="${attr(styleUri)}"><title>DGC Pips</title></head><body><main id="app"><p role="status">Connecting to local DGC…</p></main><div id="review-root"></div><script src="${attr(scriptUri)}"></script></body></html>`;
}

/** A Pip's computer in an editor tab: its Browser, Files and Terminal. */
export function computerDocument(scriptUri = '', styleUri = '', cspSource = '', title = 'Computer'): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data:; style-src ${attr(cspSource)} 'unsafe-inline'; script-src ${attr(cspSource)};"><link rel="stylesheet" href="${attr(styleUri)}"><title>${attr(title)}</title></head><body><main id="app"><p role="status">Connecting to local DGC…</p></main><script type="module" src="${attr(scriptUri)}"></script></body></html>`;
}
/** What a computer tab may ask for: its own Pip's computer, nothing else. */
const COMPUTER_COMMANDS = new Set(['get_pip_computer','open_pip_computer','use_pip_computer_view','stop_pip_computer','list_pip_computer_actions','decide_pip_computer_action','always_allow_pip_computer_action','list_pip_computer_files','read_pip_computer_file','add_pip_computer_file','remove_pip_computer_file','run_pip_computer_command','list_pip_computer_terminal','get_pip_computer_desktop','get_pip_computer_apps','set_pip_computer_apps']);
const PIP_TYPES = ['core','scout','lens','patch','rook','pulse','lock','quill'];
type ComputerPip = { id: string; name: string; pip_type: string };

/** Local Pips control bridge. Request correlation is owned by the extension host. */
export class PipsEditor implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private embeddedPost?: (message: any) => void;
  private computers = new Map<string, { panel: vscode.WebviewPanel; pip: ComputerPip }>();
  /** The CLI streams a Pip computer's full screen (ready.capabilities.pips_desktop). */
  private desktopStream = false;
  /** /learn in a Pip's chat (ready.capabilities.learn): learn_skill drafts, save_skill writes a personal skill. */
  private learn = false;
  private pending = new Map<string, { client: string; command: string; at: number; surface?: string; document?: { run: string; save: boolean; generation: number }; exportFile?: { generation: number }; keptImage?: { pip: string; message: string; index: number; generation: number }; spooled?: string[] }>();
  private generation = 0;
  private apiVersion = 0;
  /** The backend's image spool (ready.capabilities.image_spool_dir), where a Pip message's photos and files go from API 52. */
  private spoolDir = '';
  private backendIdentity?: object;
  private backgroundSetup = false;
  private state: { connected: boolean; supported: boolean; enabled: boolean } = { connected: false, supported: false, enabled: false };
  /** Reads the extension host makes for itself (the attention watcher), never a webview's. */
  private hostReads = new Map<string, (event: any) => void>();
  /** Dictation for the Pip chat's box (src/voice.ts), in this tab of its own; the side bar routes its own. */
  private dictation?: () => Dictation;
  private readAloud?: () => ReadAloud;
  private readonly mic: DictationOwner = { post: (message) => this.post({ ...message, from: 'pips' }) };
  useDictation(dictation: () => Dictation, readAloud?: () => ReadAloud): void { this.dictation = dictation; this.readAloud = readAloud; }
  /** A plugin's logo by its id (a data: URI), for a reply's "Used Aave" line; "" when it has none. */
  private pluginLogo?: (plugin: string) => string;
  usePluginLogos(lookup: (plugin: string) => string): void { this.pluginLogo = lookup; }
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
  /** Open a Pip's computer as an editor tab ("Gmail · Computer"), or bring its tab forward. */
  openComputer(pip: ComputerPip): void {
    const open = this.computers.get(pip.id);
    if (open) { open.panel.reveal(vscode.ViewColumn.Active); return; }
    const title = `${pip.name} · Computer`;
    const panel = vscode.window.createWebviewPanel('dgc.pipComputer', title, vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri],
    });
    const surface = 'computer:' + pip.id;
    this.computers.set(pip.id, { panel, pip });
    panel.onDidDispose(() => {
      this.computers.delete(pip.id);
      for (const [id, item] of this.pending) if (item.surface === surface) this.pending.delete(id);
      if (this.desktopStream && this.state.connected) this.send({ type: 'pip_desktop', pip_id: pip.id, op: 'close' }, this.backendIdentity);
    });
    panel.webview.onDidReceiveMessage(message => this.receive(message, surface));
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', name)).toString();
    panel.webview.html = computerDocument(asset('pipComputer.js'), asset('pipComputer.css'), panel.webview.cspSource, title);
  }
  /** Save a file from a Pip's computer where the user chooses. The bytes came from its own read. */
  private async saveComputerFile(surface: string, message: any): Promise<void> {
    const name = typeof message.name === 'string' && /^[^/\\\0]{1,255}$/.test(message.name) ? message.name : 'file';
    try {
      const data = typeof message.data === 'string' && /^data:[^;,]{1,200};base64,/.test(message.data) ? Buffer.from(message.data.slice(message.data.indexOf(',') + 1), 'base64')
        : typeof message.text === 'string' ? Buffer.from(message.text, 'utf8') : undefined;
      if (!data || data.byteLength > 2 * 1024 * 1024) throw Error('Nothing to save.');
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir()), name), saveLabel: 'Save' });
      if (!target) { this.post({ type: 'pipComputerSaved', ok: false, error: 'Not saved.' }, surface); return; }
      await vscode.workspace.fs.writeFile(target, data);
      this.post({ type: 'pipComputerSaved', ok: true, name: target.path.split('/').pop() }, surface);
    } catch (error) {
      this.post({ type: 'pipComputerSaved', ok: false, error: error instanceof Error ? error.message : 'Not saved.' }, surface);
    }
  }
  open(): void {
    this.embeddedPost = undefined;
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Active); this.connect(); return; }
    const panel = vscode.window.createWebviewPanel('dgc.pips', 'DGC Pips', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri],
    });
    this.panel = panel;
    panel.onDidDispose(() => { this.panel = undefined; this.pending.clear(); this.dictation?.().release(this.mic); this.readAloud?.().release(this.mic); });
    panel.onDidChangeViewState(() => panel.webview.postMessage({ type: 'pipsVisibility', visible: panel.visible }));
    panel.webview.onDidReceiveMessage(message => this.receive(message));
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', name)).toString();
    panel.webview.html = pipsDocument(asset('pips.js'), asset('pips.css'), panel.webview.cspSource);
    this.connect();
  }
  ready(capabilities: any, backendIdentity?: object): void {
    if (this.state.connected && backendIdentity && backendIdentity === this.backendIdentity) return;
    this.backendIdentity = backendIdentity;
    this.backgroundSetup = capabilities?.pips_setup_notifications === 1;
    this.apiVersion = Number.isSafeInteger(capabilities?.pips_api_version) ? capabilities.pips_api_version : 0;
    this.desktopStream = capabilities?.pips_desktop === 1;
    this.learn = Number(capabilities?.learn?.version) >= 1;
    this.spoolDir = capabilities?.image_spool === true && typeof capabilities?.image_spool_dir === 'string' ? capabilities.image_spool_dir : '';
    this.generation++;
    this.pending.clear();
    this.state = { connected: true, supported: capabilities?.pips_supported === true && capabilities?.pips_api_version >= 9, enabled: capabilities?.pips_enabled === true };
    this.publish();
  }
  offline(): void { if (!this.state.connected) return; this.generation++; this.pending.clear(); this.state.connected = false; this.publish(); }
  private publish(): void {
    // Whether a folder is open in this window: with none, the Pips view's Project tab says to open one rather than show
    // the Pips of wherever DGC happened to start. Left out where the editor doesn't say.
    const folder = vscode.workspace ? (vscode.workspace.workspaceFolders?.length ?? 0) > 0 : undefined;
    const connection = { type: 'pipsConnection', generation: this.generation, apiVersion: this.apiVersion, backgroundSetup:this.backgroundSetup, ...(folder === undefined ? {} : { folder }), ...this.state };
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
      // The screen goes only to the tab showing that Pip's computer.
      const tab = typeof event.pip_id === 'string' ? this.computers.get(event.pip_id) : undefined;
      if (tab) this.post(event.type === 'pip_desktop_data' ? { type: 'pipDesktopData', data: event.data } : { type: 'pipDesktopClosed', reason: String(event.reason || '') }, 'computer:' + event.pip_id);
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
    if (event.type === 'pips_status') this.state.enabled = event.enabled === true;
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
      || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_PHOTO_BYTES) throw gone();
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
    if (images !== undefined) {
      if (!Array.isArray(images) || images.length < 1 || images.length > MAX_SPOOLED_PHOTOS) return `Send up to ${MAX_SPOOLED_PHOTOS} photos with one message.`;
      let total = 0;
      for (const image of images) {
        const match = typeof image === 'string' ? DATA_URI.exec(image) : null;
        if (!match || !SPOOL_PHOTO_TYPES[match[1].toLowerCase()]) return 'Send photos as PNG, JPEG, GIF, WebP, BMP or iPhone (HEIC) images.';
        const size = decodedBytes(match[2]);
        if (size < 1 || size > MAX_PHOTO_BYTES || (total += size) > MAX_PHOTOS_BYTES) return PHOTO_LIMITS;
      }
    }
    if (files !== undefined) {
      if (!Array.isArray(files) || files.length < 1 || files.length > MAX_SPOOLED_FILES) return FILE_LIMITS;
      let total = 0;
      for (const f of files as any[]) {
        if (!f || typeof f !== 'object' || Object.keys(f).sort().join() !== 'data,name' || typeof f.name !== 'string' || !f.name.trim()
          || f.name.length > 255 || /[\/\\"\u0000-\u001f]/.test(f.name)) return 'Name each file plainly: no folders, quotes or control characters.';
        const match = typeof f.data === 'string' ? DATA_URI.exec(f.data) : null;
        const dot = f.name.lastIndexOf('.'), ext = dot > 0 ? f.name.slice(dot).toLowerCase() : '';
        const size = match ? decodedBytes(match[2]) : 0;
        if (!match || size < 1 || size > (DOCUMENT_EXTENSIONS.has(ext) ? MAX_DOCUMENT_BYTES : MAX_TEXT_FILE_BYTES) || (total += size) > MAX_FILES_BYTES) return FILE_LIMITS;
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
  /** Open a photo from a Pip's chat, the original, in an editor tab (one click on its thumbnail). */
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
    if (message?.type === 'pipsOpenComputer' && !computer) {
      const pip = message.pip;
      if (this.apiVersion >= 43 && pip && typeof pip.id === 'string' && /^pip_[A-Za-z0-9]{1,64}$/.test(pip.id) && typeof pip.name === 'string'
        && pip.name.trim() && pip.name.length <= 120 && PIP_TYPES.includes(pip.pip_type)) this.openComputer({ id: pip.id, name: pip.name.trim(), pip_type: pip.pip_type });
      return;
    }
    if (MIC_MESSAGES.includes(message?.type) && !computer) { if (this.dictation) void this.dictation().handle(this.mic, message); return; }
    if (SPEAK_MESSAGES.includes(message?.type) && !computer) { if (this.readAloud) void this.readAloud().handle(this.mic, message); return; }
    if (message?.type === 'pipComputerSave' && computer) { void this.saveComputerFile(surface, message); return; }
    if (message?.type === 'pipsOpenPhoto' && !computer) { void this.openPhoto(message); return; }
    if (message?.type === 'pipsPluginLogos' && !computer) {
      // The logos of the plugins a Pip's replies used ("Used [logo] Aave"), by id; "" for one with none.
      const ids = Array.isArray(message.plugins) ? message.plugins.filter((id: unknown) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)).slice(0, 16) : [];
      if (!ids.length) return;
      const logos: Record<string, string> = {};
      for (const id of ids) logos[id] = this.pluginLogo?.(id) || '';
      this.post({ type: 'pipsPluginLogos', logos }, surface);
      return;
    }
    if (message?.type === 'pipDesktop' && computer) {
      // The screen's viewer: bytes in base64, for this tab's own Pip only.
      const op = message.op, data = message.data;
      if (!this.desktopStream || !this.state.connected || !['open', 'send', 'close'].includes(op)) return;
      if (op === 'send' && (typeof data !== 'string' || !data || data.length > 1_400_000 || !/^[A-Za-z0-9+/=]+$/.test(data))) return;
      this.send({ type: 'pip_desktop', pip_id: computer.pip.id, op, ...(op === 'send' ? { data } : {}) }, this.backendIdentity);
      return;
    }
    if (message?.type === 'pipsReady') {
      if (computer) { this.post({ type: 'pipComputerInit', pip: computer.pip, desktop: this.desktopStream }, surface); this.post({ type: 'pipsConnection', generation: this.generation, apiVersion: this.apiVersion, backgroundSetup:this.backgroundSetup, ...this.state }, surface); }
      else this.publish();
      return;
    }
    if (message?.type === 'pipsReconnect') { this.pending.clear(); this.generation++; this.connect(); this.publish(); return; }
    if (message?.type !== 'pipsRequest' || typeof message.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(message.id)) return;
    const fail = (text: string) => this.post({ type: 'pipsReply', id: message.id, ok: false, error: { message: text } }, surface);
    // A computer tab is pinned to its own Pip and to the computer's commands.
    if (computer && (!COMPUTER_COMMANDS.has(message.request?.type) || (Object.prototype.hasOwnProperty.call(message.request, 'pip_id') && message.request.pip_id !== computer.pip.id))) { fail('This tab only uses this Pip\'s computer.'); return; }
    if (this.requireGeneration && message.generation !== this.generation) { fail('This view is from an earlier connection. Refresh and try again.'); return; }
    if (!this.state.connected || !this.state.supported) { fail('Pips aren’t available. Update DGC, then reconnect.'); return; }
    for (const [id, item] of this.pending) if (Date.now() - item.at > 60000) this.pending.delete(id);
    if (this.pending.size >= 64) { fail('DGC is busy. Reconnect and try again.'); return; }
    const request = message.request;
    if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.type !== 'string') return;
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
    // API 58: how much a Personal Pip asks (Ask, Approve for me, Full access). An older DGC has no levels: every Pip asks.
    if(['get_pip_level','set_pip_level'].includes(request.type) && this.apiVersion < 58) { fail('Update DGC to choose how much a Pip asks.'); return; }
    // API 59: a Personal Pip may borrow your own signed-in Chrome, with your consent each time. An older DGC has no cards to answer.
    if(['list_pip_borrows','allow_pip_borrow','decline_pip_borrow','stop_pip_borrow'].includes(request.type) && this.apiVersion < 59) { fail('Update DGC to let a Pip borrow your Chrome.'); return; }
    // API 61: your own apps' tools (registered by your code with DGC's SDK). An older DGC has none to list or accept.
    if(['list_apps','accept_app_update'].includes(request.type) && this.apiVersion < 61) { fail('Update DGC to see your own apps.'); return; }
    // API 63: the events your own app sent lately, the Routines form's suggestions.
    if(request.type === 'list_app_events' && this.apiVersion < 63) { fail('Update DGC for routines on your app\'s events.'); return; }
    // API 64: a Pip your app's code keeps from a template, and the change its template asks for.
    if(['list_pip_templates','decide_pip_template_change'].includes(request.type) && this.apiVersion < 64) { fail('Update DGC to see what your code keeps for a Pip.'); return; }
    if(request.type === 'get_pip_usage' && this.apiVersion < 41) { fail('Update DGC for Pip usage.'); return; }
    if(['get_pips_desktop_notifications','set_pips_desktop_notifications'].includes(request.type) && this.apiVersion < 41) { fail('Update DGC for desktop notifications.'); return; }
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
      const maxBytes = ['prepare_pip_connector_draft','propose_pip_connector_action','propose_pip_handoff', 'propose_pip_artifact_handoff', 'propose_pip_personal_handoff', 'propose_pip_app_action','propose_pip_calendar_action','prepare_pip_message_draft','prepare_pip_calendar_draft'].includes(request.type) ? 32768 : 16384;
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
    this.pending.set(requestId, {client: message.id, command: request.type, at: Date.now(), surface});
    if (!this.send(command, this.backendIdentity)) { this.pending.delete(requestId); fail('DGC couldn’t send that. Refresh to see whether it worked before trying again.'); }
  }
  dispose(): void { this.pending.clear(); this.embeddedPost = undefined; this.panel?.dispose(); for (const { panel } of [...this.computers.values()]) panel.dispose(); }
}
