import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

const commands = new Set(['get_pip_connector_draft','list_pip_connector_drafts','prepare_pip_connector_draft','dismiss_pip_connector_draft','inspect_pip_connector_actions','propose_pip_connector_action','get_pip_calendar_draft','list_pip_calendar_drafts','prepare_pip_calendar_draft','dismiss_pip_calendar_draft','inspect_pip_calendar_connection','propose_pip_calendar_action','get_pip_message_draft','list_pip_message_drafts','prepare_pip_message_draft','dismiss_pip_message_draft','inspect_pip_send_connection', 'propose_pip_app_action', 'get_pip_app_action', 'list_pip_app_actions', 'accept_pip_app_action', 'reject_pip_app_action', 'propose_pip_personal_handoff', 'list_pip_accounts', 'list_pip_connections', 'inspect_pip_connection', 'notify_pip_setup', 'revise_pip_setup', 'list_pip_setups', 'get_pip_setup', 'accept_pip_setup', 'reject_pip_setup', 'get_pip_statement_anchor', 'record_pip_statement', 'revoke_pip_statement', 'list_pip_statements', 'list_workspace_execution_receipts', 'get_workspace_execution_receipt', 'record_workspace_execution_context', 'archive_pip', 'restore_pip', 'get_pip_exception_source', 'record_pip_exception', 'revoke_pip_exception', 'list_pip_memories', 'list_pip_notifications', 'mark_pip_notification_read', 'list_workspace_sessions', 'inspect_workspace_session_outcome', 'propose_workspace_session_outcome', 'get_workspace_session_outcome', 'list_workspace_session_outcomes', 'accept_workspace_session_outcome', 'reject_workspace_session_outcome', 'list_pip_types', 'list_pip_models', 'list_pip_messages', 'send_pip_message', 'list_workspaces', 'list_pips', 'create_pip', 'get_pip', 'get_pip_proposal', 'list_pip_adaptations', 'run_pip', 'list_pip_runs', 'get_pip_run', 'list_pip_run_activity', 'pause_pip', 'resume_pip', 'cancel_pip_run', 'propose_pip_update', 'accept_pip_update', 'reject_pip_update', 'list_pip_versions', 'list_pip_approvals', 'list_pip_checkpoints', 'review_pip_finding', 'review_pip_execution', 'get_pip_execution', 'propose_pip_handoff', 'propose_pip_artifact_handoff', 'get_pip_handoff', 'list_pip_handoffs', 'accept_pip_handoff', 'reject_pip_handoff', 'get_pip_runner', 'stop_pips', 'get_workspace_context', 'record_workspace_context', 'archive_workspace_context', 'accept_pip_finding', 'accept_pip_execution_context']);
const attr = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function pipsDocument(scriptUri = '', styleUri = '', cspSource = ''): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${attr(cspSource)} data:; style-src ${attr(cspSource)} 'unsafe-inline'; script-src ${attr(cspSource)};"><link rel="stylesheet" href="${attr(styleUri)}"><title>DGC Pips</title></head><body><main id="app"><p role="status">Connecting to local DGC…</p></main><div id="review-root"></div><script src="${attr(scriptUri)}"></script></body></html>`;
}

/** Local Pips control bridge. Request correlation is owned by the extension host. */
export class PipsEditor implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private embeddedPost?: (message: any) => void;
  private pending = new Map<string, { client: string; command: string; at: number; document?: { run: string; save: boolean; generation: number } }>();
  private generation = 0;
  private apiVersion = 0;
  private backendIdentity?: object;
  private backgroundSetup = false;
  private state: { connected: boolean; supported: boolean; enabled: boolean } = { connected: false, supported: false, enabled: false };
  constructor(private readonly extensionUri: vscode.Uri, private readonly send: (message: any, backendIdentity?: object) => boolean, private readonly connect: () => void, private readonly requireGeneration = false) {}
  attach(post: (message: any) => void): void {
    // The main panel is now the primary surface. Retire any old editor instance
    // before changing the reply destination, so requests cannot cross surfaces.
    this.panel?.dispose();
    this.pending.clear();
    this.generation++;
    this.embeddedPost = post;
  }
  private post(message: any): void {
    if (this.embeddedPost) this.embeddedPost(message);
    else this.panel?.webview.postMessage(message);
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
    this.generation++;
    this.pending.clear();
    this.state = { connected: true, supported: capabilities?.pips_supported === true && capabilities?.pips_api_version >= 9, enabled: capabilities?.pips_enabled === true };
    this.publish();
  }
  offline(): void { if (!this.state.connected) return; this.generation++; this.pending.clear(); this.state.connected = false; this.publish(); }
  private publish(): void { this.post({ type: 'pipsConnection', generation: this.generation, apiVersion: this.apiVersion, backgroundSetup:this.backgroundSetup, ...this.state }); }
  event(event: any): boolean {
    if (!['pips_result', 'pips_status'].includes(event.type) && !(event.type === 'command_rejected' && ['pips_control', 'pips_enable', 'pips_runtime'].includes(event.command))) return false;
    const owner = this.pending.get(event.request_id);
    if (!owner) return true;
    if (event.type === 'pips_result' && event.command !== owner.command) return true;
    this.pending.delete(event.request_id);
    if (owner.document && event.type === 'pips_result' && event.ok === true) {
      void this.openResultDocument(owner.client, owner.document, event.result?.run);
      return true;
    }
    if (event.type === 'pips_status') this.state.enabled = event.enabled === true;
    this.post({ type: 'pipsReply', id: owner.client,
      ok: event.type !== 'command_rejected' && (event.type === 'pips_status' || event.ok === true),
      result: event.type === 'pips_status' ? event : event.result,
      error: event.type === 'command_rejected' ? {message: event.message} : event.error });
    return true;
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
  receive(message: any): void {
    if (message?.type === 'pipsReady') { this.publish(); return; }
    if (message?.type === 'pipsReconnect') { this.pending.clear(); this.generation++; this.connect(); this.publish(); return; }
    if (message?.type !== 'pipsRequest' || typeof message.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(message.id)) return;
    const fail = (text: string) => this.post({ type: 'pipsReply', id: message.id, ok: false, error: { message: text } });
    if (this.requireGeneration && message.generation !== this.generation) { fail('This Pip view belongs to an earlier chat connection. Refresh before trying again.'); return; }
    if (!this.state.connected || !this.state.supported) { fail('The local Pips backend is unavailable. Update the DGC CLI to Pips API v9 or later, then reconnect.'); return; }
    for (const [id, item] of this.pending) if (Date.now() - item.at > 60000) this.pending.delete(id);
    if (this.pending.size >= 64) { fail('Too many requests are pending. Reconnect before trying again.'); return; }
    const request = message.request;
    if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.type !== 'string') return;
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
    if(request.type==='notify_pip_setup'&&!this.backgroundSetup){fail('Setup is saved. Reload the window to get background approval notifications.');return;}
    let command: any;
    if (request.type === 'pips_enable' && typeof request.enabled === 'boolean') {
      command = {type: 'pips_enable', enabled: request.enabled, request_id: requestId};
    } else if (request.type === 'pips_runtime' && ['start', 'resume'].includes(request.action)) {
      command = {type: 'pips_runtime', action: request.action, request_id: requestId};
    } else if (commands.has(request.type)) {
      const nested = {...request, request_id: requestId};
      const maxBytes = ['prepare_pip_connector_draft','propose_pip_connector_action','propose_pip_handoff', 'propose_pip_artifact_handoff', 'propose_pip_personal_handoff', 'propose_pip_app_action','propose_pip_calendar_action','prepare_pip_message_draft','prepare_pip_calendar_draft'].includes(request.type) ? 32768 : 16384;
      if (Buffer.byteLength(JSON.stringify(nested), 'utf8') > maxBytes) { fail(`This request exceeds the ${maxBytes / 1024} KiB limit. Nothing was sent.`); return; }
      command = {type: 'pips_control', request: nested};
    } else { fail('Unknown Pips command.'); return; }
    this.pending.set(requestId, {client: message.id, command: request.type, at: Date.now()});
    if (!this.send(command, this.backendIdentity)) { this.pending.delete(requestId); fail('DGC could not send the request. Its outcome is unknown; refresh before retrying.'); }
  }
  dispose(): void { this.pending.clear(); this.embeddedPost = undefined; this.panel?.dispose(); }
}
