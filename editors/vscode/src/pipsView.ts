import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { homedir } from 'os';

const commands = new Set(['get_pip_computer_desktop','list_pip_computer_files','read_pip_computer_file','add_pip_computer_file','remove_pip_computer_file','run_pip_computer_command','list_pip_computer_terminal','get_pip_message_image','introduce_pip','always_allow_pip_computer_action','get_pip_computer','list_pip_computer_actions','decide_pip_computer_action','get_pip_computer_frame','list_pip_computer_frames','stop_pip_computer','open_pip_computer','use_pip_computer_view','always_allow_pip_app_action','list_pip_action_grants','revoke_pip_action_grant','set_pip_feedback','list_pip_feedback','export_pip','get_pip_usage','set_pip_daily_cap','get_pips_desktop_notifications','set_pips_desktop_notifications','get_pips_keep_running','set_pips_keep_running','list_pip_starters','propose_starter_pip','get_pip_digest','mark_pip_digest_seen','get_pip_notify_settings','set_pip_notify_settings','get_pip_outcomes','get_pip_connector_draft','list_pip_connector_drafts','prepare_pip_connector_draft','dismiss_pip_connector_draft','inspect_pip_connector_actions','propose_pip_connector_action','get_pip_calendar_draft','list_pip_calendar_drafts','prepare_pip_calendar_draft','dismiss_pip_calendar_draft','inspect_pip_calendar_connection','propose_pip_calendar_action','get_pip_message_draft','list_pip_message_drafts','prepare_pip_message_draft','dismiss_pip_message_draft','inspect_pip_send_connection', 'propose_pip_app_action', 'get_pip_app_action', 'list_pip_app_actions', 'accept_pip_app_action', 'reject_pip_app_action', 'propose_pip_personal_handoff', 'list_pip_accounts', 'list_pip_connections', 'inspect_pip_connection', 'notify_pip_setup', 'revise_pip_setup', 'list_pip_setups', 'get_pip_setup', 'accept_pip_setup', 'reject_pip_setup', 'get_pip_statement_anchor', 'record_pip_statement', 'revoke_pip_statement', 'list_pip_statements', 'list_workspace_execution_receipts', 'get_workspace_execution_receipt', 'record_workspace_execution_context', 'archive_pip', 'restore_pip', 'get_pip_exception_source', 'record_pip_exception', 'revoke_pip_exception', 'list_pip_memories', 'list_pip_notifications', 'mark_pip_notification_read', 'list_workspace_sessions', 'inspect_workspace_session_outcome', 'propose_workspace_session_outcome', 'get_workspace_session_outcome', 'list_workspace_session_outcomes', 'accept_workspace_session_outcome', 'reject_workspace_session_outcome', 'list_pip_types', 'list_pip_models', 'list_pip_messages', 'send_pip_message', 'list_workspaces', 'list_pips', 'create_pip', 'get_pip', 'get_pip_proposal', 'list_pip_adaptations', 'run_pip', 'list_pip_runs', 'get_pip_run', 'list_pip_run_activity', 'pause_pip', 'resume_pip', 'cancel_pip_run', 'propose_pip_update', 'accept_pip_update', 'reject_pip_update', 'list_pip_versions', 'list_pip_approvals', 'list_pip_checkpoints', 'review_pip_finding', 'review_pip_execution', 'get_pip_execution', 'propose_pip_handoff', 'propose_pip_artifact_handoff', 'get_pip_handoff', 'list_pip_handoffs', 'accept_pip_handoff', 'reject_pip_handoff', 'get_pip_runner', 'stop_pips', 'get_workspace_context', 'record_workspace_context', 'archive_workspace_context', 'accept_pip_finding', 'accept_pip_execution_context']);
/** Images sent with a Pip message, as data URIs: 2 MiB of image, base64, plus headers. */
const MAX_IMAGE_URI_CHARS = 2_800_000;
const attr = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function pipsDocument(scriptUri = '', styleUri = '', cspSource = ''): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data:; style-src ${attr(cspSource)} 'unsafe-inline'; script-src ${attr(cspSource)};"><link rel="stylesheet" href="${attr(styleUri)}"><title>DGC Pips</title></head><body><main id="app"><p role="status">Connecting to local DGC…</p></main><div id="review-root"></div><script src="${attr(scriptUri)}"></script></body></html>`;
}

/** A Pip's computer in an editor tab: its Browser, Files and Terminal. */
export function computerDocument(scriptUri = '', styleUri = '', cspSource = '', title = 'Computer'): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data:; style-src ${attr(cspSource)} 'unsafe-inline'; script-src ${attr(cspSource)};"><link rel="stylesheet" href="${attr(styleUri)}"><title>${attr(title)}</title></head><body><main id="app"><p role="status">Connecting to local DGC…</p></main><script type="module" src="${attr(scriptUri)}"></script></body></html>`;
}
/** What a computer tab may ask for: its own Pip's computer, nothing else. */
const COMPUTER_COMMANDS = new Set(['get_pip_computer','open_pip_computer','use_pip_computer_view','stop_pip_computer','list_pip_computer_actions','decide_pip_computer_action','always_allow_pip_computer_action','list_pip_computer_files','read_pip_computer_file','add_pip_computer_file','remove_pip_computer_file','run_pip_computer_command','list_pip_computer_terminal','get_pip_computer_desktop']);
const PIP_TYPES = ['core','scout','lens','patch','rook','pulse','lock','quill'];
type ComputerPip = { id: string; name: string; pip_type: string };

/** Local Pips control bridge. Request correlation is owned by the extension host. */
export class PipsEditor implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private embeddedPost?: (message: any) => void;
  private computers = new Map<string, { panel: vscode.WebviewPanel; pip: ComputerPip }>();
  /** The CLI streams a Pip computer's full screen (ready.capabilities.pips_desktop). */
  private desktopStream = false;
  private pending = new Map<string, { client: string; command: string; at: number; surface?: string; document?: { run: string; save: boolean; generation: number }; exportFile?: { generation: number } }>();
  private generation = 0;
  private apiVersion = 0;
  private backendIdentity?: object;
  private backgroundSetup = false;
  private state: { connected: boolean; supported: boolean; enabled: boolean } = { connected: false, supported: false, enabled: false };
  /** Reads the extension host makes for itself (the attention watcher), never a webview's. */
  private hostReads = new Map<string, (event: any) => void>();
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
    panel.onDidDispose(() => { this.panel = undefined; this.pending.clear(); });
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
    this.generation++;
    this.pending.clear();
    this.state = { connected: true, supported: capabilities?.pips_supported === true && capabilities?.pips_api_version >= 9, enabled: capabilities?.pips_enabled === true };
    this.publish();
  }
  offline(): void { if (!this.state.connected) return; this.generation++; this.pending.clear(); this.state.connected = false; this.publish(); }
  private publish(): void {
    const connection = { type: 'pipsConnection', generation: this.generation, apiVersion: this.apiVersion, backgroundSetup:this.backgroundSetup, ...this.state };
    this.post(connection);
    for (const id of this.computers.keys()) this.post(connection, 'computer:' + id);
  }
  /** One host-owned read through the same channel: only the digest, only on an API 41 backend. */
  hostRead(type: 'get_pip_digest'): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.state.connected || !this.state.supported || !this.state.enabled || this.apiVersion < 41) { reject(new Error('Pips are unavailable.')); return; }
      const requestId = 'pips-host-' + randomBytes(12).toString('hex');
      const timer = setTimeout(() => { this.hostReads.delete(requestId); reject(new Error('No reply from DGC.')); }, 20000);
      this.hostReads.set(requestId, (event) => {
        clearTimeout(timer); this.hostReads.delete(requestId);
        if (event.type === 'pips_result' && event.ok === true && event.command === type) resolve(event.result); else reject(new Error('DGC could not read Pips.'));
      });
      if (!this.send({ type: 'pips_control', request: { type, request_id: requestId } }, this.backendIdentity)) {
        clearTimeout(timer); this.hostReads.delete(requestId); reject(new Error('DGC is not connected.'));
      }
    });
  }
  event(event: any): boolean {
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
    if (event.type === 'pips_status') this.state.enabled = event.enabled === true;
    this.post({ type: 'pipsReply', id: owner.client,
      ok: event.type !== 'command_rejected' && (event.type === 'pips_status' || event.ok === true),
      result: event.type === 'pips_status' ? event : event.result,
      error: event.type === 'command_rejected' ? {message: event.message} : event.error }, owner.surface);
    return true;
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
      const content = `Saved Pip result · ${requested.run}\n\nModel-authored document. Review before relying on or sharing it.\n\n${text}\n`;
      const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
      if (requested.generation !== this.generation || !this.state.connected) throw Error('The DGC connection changed. Open the result again.');
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
      if (requested.save) await vscode.commands.executeCommand('workbench.action.files.saveAs', document.uri);
      this.post({type:'pipsReply', id:client, ok:true, result:{opened:true}});
    } catch (error) {
      this.post({type:'pipsReply', id:client, ok:false, error:{message:error instanceof Error ? error.message : 'Could not open the saved document.'}});
    }
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
    if (message?.type === 'pipComputerSave' && computer) { void this.saveComputerFile(surface, message); return; }
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
    if (this.requireGeneration && message.generation !== this.generation) { fail('This Pip view belongs to an earlier chat connection. Refresh before trying again.'); return; }
    if (!this.state.connected || !this.state.supported) { fail('The local Pips backend is unavailable. Update the DGC CLI to Pips API v9 or later, then reconnect.'); return; }
    for (const [id, item] of this.pending) if (Date.now() - item.at > 60000) this.pending.delete(id);
    if (this.pending.size >= 64) { fail('Too many requests are pending. Reconnect before trying again.'); return; }
    const request = message.request;
    if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.type !== 'string') return;
    if (request.type === 'export_pip_file' || request.type === 'import_pip_file') {
      if (this.apiVersion < 41) { fail('Update the DGC CLI (Pips API 41) to share Pips.'); return; }
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
    if (['get_pip_connector_draft','list_pip_connector_drafts','prepare_pip_connector_draft','dismiss_pip_connector_draft'].includes(request.type) && this.apiVersion < 37) { fail('Update the DGC CLI (Pips API 37) for conversational connector drafts.'); return; }
    if (['get_pip_calendar_draft','list_pip_calendar_drafts','prepare_pip_calendar_draft','dismiss_pip_calendar_draft'].includes(request.type) && this.apiVersion < 35) { fail('Update the DGC CLI (Pips API 35) for conversational calendar drafts.'); return; }
    if (['get_pip_message_draft','list_pip_message_drafts','prepare_pip_message_draft','dismiss_pip_message_draft'].includes(request.type) && this.apiVersion < 32) { fail('Update the DGC CLI (Pips API 32) for conversational email drafts.'); return; }
    if (['inspect_pip_connector_actions','propose_pip_connector_action'].includes(request.type) && this.apiVersion < 36) { fail('Update the DGC CLI (Pips API 36) for reviewed connector actions.'); return; }
    if (['inspect_pip_calendar_connection','propose_pip_calendar_action'].includes(request.type) && this.apiVersion < 34) { fail('Update the DGC CLI (Pips API 34) for reviewed calendar events.'); return; }
    if (['inspect_pip_send_connection', 'propose_pip_app_action', 'get_pip_app_action', 'list_pip_app_actions', 'accept_pip_app_action', 'reject_pip_app_action'].includes(request.type) && this.apiVersion < 31) { fail('Update the DGC CLI (Pips API 31) for reviewed messages.'); return; }
    if (request.type === 'propose_pip_personal_handoff' && this.apiVersion < 30) { fail('Update the DGC CLI (Pips API 30) for Personal result handoffs.'); return; }
    if (request.type === 'list_pip_accounts' && this.apiVersion < 29) { fail('Update the DGC CLI (Pips API 29) for connected-account selection.'); return; }
    if (request.type === 'revise_pip_setup' && this.apiVersion < 25) { fail('Update the computer to Pips API 25 to change the model on a setup card.'); return; }
    if (request.type === 'send_pip_message' && Object.prototype.hasOwnProperty.call(request, 'chat_options') && this.apiVersion < 24) { fail('Update the computer to Pips API 24 for conversation context and thinking controls.'); return; }
    if (request.type === 'send_pip_message' && Number(request.chat_options?.context_size) > 32768 && this.apiVersion < 25) { fail('Update the computer to Pips API 25 for conversation context above 32768 tokens.'); return; }
    if (['propose_pip_calendar_action','prepare_pip_calendar_draft'].includes(request.type) && request.event && ['attendees','repeat','send_invitations'].some(key => Object.prototype.hasOwnProperty.call(request.event,key)) && this.apiVersion < 38) { fail('Update the DGC CLI (Pips API 38) for calendar invitations and series.'); return; }
    if (request.type === 'propose_pip_update' && Object.prototype.hasOwnProperty.call(request.changes || {}, 'web_plan') && this.apiVersion < 40) { fail('Update the DGC CLI (Pips API 40) for web reads.'); return; }
    if (request.type === 'propose_pip_update' && request.changes?.app_plan?.schema_version === 3 && this.apiVersion < 39) { fail('Update the DGC CLI (Pips API 39) for Drive, Notion and Contacts reads.'); return; }
    if (request.type === 'propose_pip_update' && request.changes?.app_plan?.schema_version === 2 && this.apiVersion < 33) { fail('Update the DGC CLI (Pips API 33) for recurring calendar windows.'); return; }
    if ((['list_pip_connections','inspect_pip_connection'].includes(request.type) || request.type === 'propose_pip_update' && Object.prototype.hasOwnProperty.call(request.changes || {}, 'app_plan')) && this.apiVersion < 28) { fail('Update the DGC CLI (Pips API 28) for reviewed app reads.'); return; }
    if (['list_pip_setups', 'get_pip_setup', 'accept_pip_setup', 'reject_pip_setup'].includes(request.type) && this.apiVersion < 23) { fail('Update the computer to Pips API 23 for conversational setup reviews.'); return; }
    if ((['get_pip_proposal', 'list_pip_adaptations'].includes(request.type) || request.type === 'propose_pip_update' && (request.changes?.adaptation_policy !== undefined || request.changes?.event_trigger !== undefined)) && this.apiVersion < 10) { fail('Update the computer to Pips API 10 for this control.'); return; }
    if ((request.type === 'propose_pip_update' && Object.prototype.hasOwnProperty.call(request.changes || {}, 'verification_plan') || request.type === 'run_pip' && ['expected_version', 'expected_lifecycle_revision', 'expected_plan_digest'].some(key => Object.prototype.hasOwnProperty.call(request, key))) && this.apiVersion < 21) { fail('Update the computer to Pips API 21 for reviewed standalone Pulse commands.'); return; }
    if (request.type === 'propose_pip_update' && (Object.prototype.hasOwnProperty.call(request.changes?.event_trigger || {}, 'commit_paths') || Array.isArray(request.changes?.event_trigger?.events) && request.changes.event_trigger.events.includes('committed_paths_changed')) && this.apiVersion < 22) { fail('Update the computer to Pips API 22 to review committed-path rules.'); return; }
    if (request.type === 'propose_pip_update' && Array.isArray(request.changes?.event_trigger?.events) && request.changes.event_trigger.events.includes('session_turn_completed') && this.apiVersion < 18) { fail('Update the computer to Pips API 18 to review Session turn saved.'); return; }
    if (request.type === 'propose_pip_update' && request.changes?.source_policy !== undefined && this.apiVersion < 11) { fail('Update the computer to Pips API 11 to review source policy.'); return; }
    if (['list_workspace_execution_receipts', 'get_workspace_execution_receipt', 'record_workspace_execution_context'].includes(request.type) && this.apiVersion < 17) { fail('Update the computer to Pips API 17 for recorded command outcomes.'); return; }
    if ((['archive_pip', 'restore_pip'].includes(request.type) || ['pause_pip', 'resume_pip'].includes(request.type) && request.expected_lifecycle_revision !== undefined) && this.apiVersion < 16) { fail('Update the computer to Pips API 16 for reviewed lifecycle changes.'); return; }
    if (request.action && Object.prototype.hasOwnProperty.call(request.action, 'specialists') && this.apiVersion < 15) { fail('Update the computer to Pips API 15 before reviewing specialists.'); return; }
    if (['get_pip_statement_anchor', 'record_pip_statement', 'revoke_pip_statement', 'list_pip_statements'].includes(request.type) && this.apiVersion < 19) { fail('Update the computer to Pips API 19 for reviewed Pip claims and preferences.'); return; }
    if (['get_pip_exception_source', 'record_pip_exception', 'revoke_pip_exception', 'list_pip_memories'].includes(request.type) && this.apiVersion < 14) { fail('Update the computer to Pips API 14 for source-bound exceptions.'); return; }
    if (['list_pip_notifications', 'mark_pip_notification_read'].includes(request.type) && this.apiVersion < 13) { fail('Update the computer to Pips API 13 for notifications.'); return; }
    if ((request.type === 'list_workspace_sessions' || request.type.includes('workspace_session_outcome')) && this.apiVersion < 12) { fail('Update the computer to Pips API 12 for reviewed session statements.'); return; }
    const requestId = 'pips-editor-' + randomBytes(12).toString('hex');
    if (request.type === 'propose_pip_update' && Object.prototype.hasOwnProperty.call(request.changes || {}, 'github_plan') && this.apiVersion < 41) { fail('Update the DGC CLI (Pips API 41) for GitHub reads.'); return; }
    if (request.type === 'propose_pip_update' && Object.prototype.hasOwnProperty.call(request.changes || {}, 'computer_plan') && this.apiVersion < 42) { fail('Update the DGC CLI (Pips API 42) to give a Pip a computer.'); return; }
    if(request.type === 'introduce_pip' && this.apiVersion < 43) { fail('Update the DGC CLI (Pips API 43) for Pips that say hello.'); return; }
    if(request.type === 'send_pip_message' && Object.prototype.hasOwnProperty.call(request, 'files') && this.apiVersion < 43) { fail('Update the DGC CLI (Pips API 43) to send files to a Pip.'); return; }
    if((request.type === 'get_pip_message_image' || request.type === 'send_pip_message' && Object.prototype.hasOwnProperty.call(request, 'images')) && this.apiVersion < 43) { fail('Update the DGC CLI (Pips API 43) to send images to a Pip.'); return; }
    if(['list_pip_computer_files','read_pip_computer_file','add_pip_computer_file','remove_pip_computer_file','run_pip_computer_command','list_pip_computer_terminal','get_pip_computer_desktop'].includes(request.type) && this.apiVersion < 43) { fail('Update the DGC CLI (Pips API 43) for a Pip computer\'s Files and Terminal.'); return; }
    if(['always_allow_pip_computer_action','get_pip_computer','list_pip_computer_actions','decide_pip_computer_action','get_pip_computer_frame','list_pip_computer_frames','stop_pip_computer','open_pip_computer','use_pip_computer_view'].includes(request.type) && this.apiVersion < 42) { fail('Update the DGC CLI (Pips API 42) for Pip computers.'); return; }
    if(['always_allow_pip_app_action','list_pip_action_grants','revoke_pip_action_grant'].includes(request.type) && this.apiVersion < 41) { fail('Update the DGC CLI (Pips API 41) to let a Pip act without asking.'); return; }
    if(['set_pip_feedback','list_pip_feedback'].includes(request.type) && this.apiVersion < 41) { fail('Update the DGC CLI (Pips API 41) to rate Pip results.'); return; }
    if(['get_pip_usage','set_pip_daily_cap'].includes(request.type) && this.apiVersion < 41) { fail('Update the DGC CLI (Pips API 41) for Pip usage and daily limits.'); return; }
    if(['get_pips_desktop_notifications','set_pips_desktop_notifications'].includes(request.type) && this.apiVersion < 41) { fail('Update the DGC CLI (Pips API 41) for desktop notifications.'); return; }
    if(['get_pips_keep_running','set_pips_keep_running'].includes(request.type) && this.apiVersion < 41) { fail('Update the DGC CLI (Pips API 41) to keep Pips running.'); return; }
    if(['list_pip_starters','propose_starter_pip'].includes(request.type) && this.apiVersion < 41) { fail('Update the DGC CLI (Pips API 41) for starter Pips.'); return; }
    if(['get_pip_digest','mark_pip_digest_seen','get_pip_notify_settings','set_pip_notify_settings','get_pip_outcomes'].includes(request.type) && this.apiVersion < 41) { fail('Update the DGC CLI (Pips API 41) for the Pips digest and notification settings.'); return; }
    if(request.type==='notify_pip_setup'&&!this.backgroundSetup){fail('Setup is saved. Reload the window to get background approval notifications.');return;}
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
    if (!this.send(command, this.backendIdentity)) { this.pending.delete(requestId); fail('DGC could not send the request. Its outcome is unknown; refresh before retrying.'); }
  }
  dispose(): void { this.pending.clear(); this.embeddedPost = undefined; this.panel?.dispose(); for (const { panel } of [...this.computers.values()]) panel.dispose(); }
}
