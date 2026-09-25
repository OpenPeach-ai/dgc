import { APP_CONNECTORS } from './appConnectors';
import './settings.css';
import zapierLogo from '../media/plugin-logos/zapier.ico';
import makeLogo from '../media/plugin-logos/make.ico';
import n8nLogo from '../media/plugin-logos/n8n.ico';
import arcadeLogo from '../media/plugin-logos/arcade.svg';
import composioLogo from '../media/plugin-logos/composio.svg';
import googleLogo from '../media/plugin-logos/google.png';
import figmaLogo from '../media/plugin-logos/figma.png';
import gmailLogo from '../media/plugin-logos/gmail.png';
import calendarLogo from '../media/plugin-logos/calendar.png';
import contactsLogo from '../media/plugin-logos/contacts.png';
import driveLogo from '../media/plugin-logos/drive.png';
import dgcLogo from '../media/dgc-mark.svg';
const connectorLogos = {zapier:zapierLogo, make:makeLogo, n8n:n8nLogo, arcade:arcadeLogo};
const serviceLogos = {gmail:gmailLogo, calendar:calendarLogo, contacts:contactsLogo, drive:driveLogo};
import { renderFields } from './settingsFields.js';
import { createUsage } from './settingsUsage.js';
import { usageMarkup } from './settingsUsageMarkup.js';
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const paths = { general: 'M9 3h6l1 3 3 1v6l-3 1-1 3H9l-1-3-3-1V7l3-1z M13 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0', models: 'M4 6h14M4 11h14M4 16h14M7 4v4M14 9v4M9 14v4', agents: 'M9 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0M3 17v-3a3 3 0 0 1 6 0v3M13 5h5M13 10h5M13 15h5', usage: 'M4 17V9M10 17V3M16 17v-6', security: 'M10 2l7 3v5c0 5-7 8-7 8S3 15 3 10V5z M7 10l2 2 4-4', plugins: 'M3 7h5V3h4v4h5v5h-4v5H8v-5H3z', mcp: 'M7 3v5M13 3v5M5 8h10v3a5 5 0 0 1-10 0z M10 16v3', panel: 'M3 3h15v15H3z M8 3v15', gear: 'M8 3h4l1 3 3 1v4l-3 1-1 3H8l-1-3-3-1V7l3-1z M12 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0', app: 'M4 3h13v14H4z M4 7h13' };
const icon = name => `<svg viewBox="0 0 21 21" aria-hidden="true"><path d="${paths[name] || paths.plugins}"/></svg>`;
const sections = [['general', 'General'], ['models', 'Models'], ['agents', 'Agents'], ['usage', 'Token usage'], ['security', 'Security'], ['plugins', 'Plugins'], ['mcp', 'MCP servers']];
let section = 'general', lane = 'plugins', detail = '', query = '', items = [], servers = [], providers = [], signin = null, config = null, draft = {}, dirty = new Set(), usage = null, range = '7d', saving = false, saveStatus = '', mcpEditing = null;
let mcpError = "";
let sequence = 0;
let directory = false, marketFilter = 'all', marketplaces = [], pluginNotice = '', modal = null, modalKind = '', reviewName = '', preview = null, dialogReturn = null, createdPath = '';
let operationPending = false;
let connectingPlugin = null;
const errors = new Map(), pending = new Map(), skillPending = new Map();
const send = m => vscode.postMessage(m);
const switchHTML = (on, label, attrs = '', disabled = false) => `<button type="button" class="switch${on ? ' on' : ''}" role="switch" aria-checked="${!!on}" aria-label="${esc(label)}" ${attrs}${disabled ? ' disabled' : ''}><i></i></button>`;
const ui = {
    field: (label, hint, control) => `<label class="field"><span><span class="name">${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</span>${control}</label>`,
    sel: (id, options, value) => `<select id="${id}">${options.map(([v, label]) => `<option value="${esc(v)}"${String(value ?? '') === String(v) ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`,
    inp: (id, value, type = 'text') => `<input id="${id}" type="${type}" value="${esc(value ?? '')}" autocomplete="off" spellcheck="false">`,
    bool: (id, on) => switchHTML(on, id.replaceAll('_', ' '), `id="${id}" data-setting="${id}"`),
    card: (title, body) => `<div class="card"><h3>${title}</h3>${body}</div>`
};
const defaults = { base_url: '', api_key: '', model: '', api_mode: 'auto', provider_state: 'stateless', prompt_cache: true, capability_cache_ttl_s: 3600, subscription_engine: '', subscription_model: '', subscription_effort: '', subagent_model: '', subagent_base_url: '', subagent_api_mode: '', subagent_api_key: '', fallback_model: '', fallback_base_url: '', fallback_api_mode: '', fallback_api_key: '', mode: 'default', think: 'off', context_size: 32768, show_reasoning: true, thinking_inline: true, ultra_mode: false, suggest: true, monitor_wake: true, tool_profile: 'standard', max_parallel_tasks: 4, sandbox: false, sandbox_network: false, plan_artifact: true, artifact_autostart: true, artifact_in_plan: false };
function setDraft(key, value) { draft[key] = value; dirty.add(key); saveStatus = 'Unsaved changes'; if ($('save-status'))
    $('save-status').textContent = saveStatus; }
function applyConfig(ev) {
    config = ev;
    for (const [key, fallback] of Object.entries(defaults)) {
        if (!dirty.has(key))
            draft[key] = key.endsWith('api_key') ? '' : ev[key] ?? fallback;
    }
    if (!dirty.has('think') && draft.subscription_engine)
        draft.think = draft.subscription_effort || 'off';
    if (['general', 'models', 'agents', 'security'].includes(section) && !saving)
        render();
}
function snapshot() {
    if (!config)
        return;
    document.querySelectorAll('#page input[id],#page select[id]').forEach(el => {
        let key = el.id;
        if (!(key in defaults))
            return;
        let value = el.value.trim();
        if (key === 'show_reasoning') {
            const shown = value;
            if (draft.show_reasoning !== (shown !== 'hidden'))
                setDraft('show_reasoning', shown !== 'hidden');
            if (draft.thinking_inline !== (shown === 'inline'))
                setDraft('thinking_inline', shown === 'inline');
            return;
        }
        if (String(draft[key] ?? '') !== value) {
            setDraft(key, value);
            if (key === 'subscription_engine')
                setDraft('think', value ? (draft.subscription_effort || 'off') : (config.think || 'off'));
            if (key === 'subscription_effort' && draft.subscription_engine)
                setDraft('think', value || 'off');
            if (key === 'think' && draft.subscription_engine)
                setDraft('subscription_effort', value === 'off' ? '' : value);
        }
    });
}
function navTo(next, nextRange) { snapshot(); directory = false; section = sections.some(([id]) => id === next) ? next : 'general'; detail = ''; mcpEditing = null; if (nextRange)
    range = nextRange; render(); $('main').scrollTop = 0; }
// Catalog acknowledgements replace rows. Keep keyboard focus on the same control.
let rememberedFocus = null;
document.addEventListener('focusin', event => {
    const element = event.target;
    rememberedFocus = null;
    if (!$('page').contains(element)) return;
    for (const key of ['id', 'data-plugin', 'data-skill', 'data-install', 'data-mcp-toggle', 'data-lane']) {
        if (element.hasAttribute(key)) { rememberedFocus = [key, element.getAttribute(key)]; break; }
    }
});
function render() {
    const previousFocus = rememberedFocus;
    queueMicrotask(() => {
        if (!previousFocus || document.activeElement !== document.body) return;
        const [key, value] = previousFocus;
        const candidate = [...$('page').querySelectorAll('[' + key + ']')].find(el => el.getAttribute(key) === value);
        if (candidate && !candidate.disabled) candidate.focus({preventScroll: true});
    });
    usage?.dispose();
    usage = null;
    document.querySelectorAll('[data-nav]').forEach(b => { b.classList.toggle('active', b.dataset.nav === section); b.setAttribute('aria-current', b.dataset.nav === section ? 'page' : 'false'); });
    const main = $('page');
    if (section === 'plugins') {
        renderPlugins(main);
        return;
    }
    if (section === 'mcp') {
        renderMcp(main);
        return;
    }
    if (section === 'usage') {
        main.innerHTML = '<h1>Token usage</h1><p class="sub">Your local ledger of model requests.</p>' + usageMarkup;
        usage = createUsage(main.querySelector('.usage-section'), vscode);
        $('usage-range').value = range;
        usage.request();
        $('usage-range').addEventListener('change', () => range = $('usage-range').value);
        return;
    }
    if (!config) {
        main.innerHTML = '<h1>' + sections.find(([id]) => id === section)[1] + '</h1><p class="sub" role="status">Reading settings from DGC…</p>';
        return;
    }
    renderFields(section, main, draft, providers, ui);
    const save = $('save');
    save.disabled = saving;
    save.insertAdjacentHTML('afterend', ' <span class="save-status" id="save-status" role="status">' + esc(saveStatus) + '</span>');
    for (const [id, min, max, step] of [['context_size', 2048, null, 1024], ['max_parallel_tasks', 1, 8, 1], ['capability_cache_ttl_s', 1, null, 1]]) {
        const input = $(id);
        if (input) { input.min = String(min); input.step = String(step); if (max) input.max = String(max); }
    }
    save.onclick = () => { if ([...main.querySelectorAll('input')].some(input => !input.reportValidity())) return; snapshot(); saving = true; save.disabled = true; save.textContent = 'Saving…'; send({ type: 'saveSettings', values: { ...draft } }); };
    main.querySelectorAll('input,select').forEach(el => el.addEventListener('input', () => { snapshot(); }));
    main.querySelectorAll('[data-setting]').forEach(b => b.onclick = () => { const on = b.getAttribute('aria-checked') !== 'true'; setDraft(b.dataset.setting, on); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    for (const [presetId, urlId] of [['provider', 'base_url'], ['subagent_provider', 'subagent_base_url']]) {
        const el = $(presetId);
        if (el)
            el.onchange = () => { const p = providers.find(x => x.id === el.value); if (p) {
                $(urlId).value = p.url;
                setDraft(urlId, p.url);
            } };
    }
}
function appLogo(row, app) { return row.name === 'google-workspace' && serviceLogos[app.id] ? logo({name:app.id, display_name:app.name, logo:serviceLogos[app.id]}) : logo(row); }
function logo(row, big = false) { if (connectorLogos[row.name]) row = {...row, logo:connectorLogos[row.name]}; if (row.name === 'composio') row = {...row, logo:composioLogo}; if (row.name === 'google-workspace') row = {...row, logo:googleLogo}; return row.logo ? `<img class="logo" width="${big ? 72 : 40}" height="${big ? 72 : 40}" alt="${esc(row.display_name || row.name)}" src="${esc(row.logo)}">` : `<span class="mark" aria-hidden="true">${icon('plugins')}</span>`; }
function banner(row) { if (!signin || row && signin.server !== row.name && !(row.server_names || []).includes(signin.server))
    return ''; return `<div class="banner" role="status"><p>Finish connecting ${esc(signin.title)} in your browser</p><div class="actions"><button class="secondary" data-browser>Open browser</button><button class="secondary" data-cancel-connect>Cancel</button></div></div>`; }
function issue(row) { const message = errors.get(row.name) || row.connection_error; return message ? `<div class="banner error" role="alert"><p>${esc(message)}</p></div>` : ''; }
function pluginControl(row) {
    if (!offered(row)) return '<span class="status">Unavailable</span>';
    if (pending.has(row.name) || row.opening)
        return '<button class="install" disabled>' + (row.opening || row.installed ? 'Connecting…' : 'Installing…') + '</button>';
    if (!row.installed)
        return `<button class="install" data-install="${esc(row.name)}"${row.install === 'block' ? ' disabled' : ''}>${row.install === 'block' ? 'Not offered' : 'Install'}</button>`;
    if (row.skills?.length)
        return switchHTML(row.skills.every(s => s.enabled !== false), `Enable ${row.display_name} skills`, `data-plugin="${esc(row.name)}"`, row.skills.some(s => skillPending.has(s.name)));
    return `<span class="status${row.connected ? ' connected' : ''}">${row.connected ? 'Connected' : row.setup_required ? 'Setup required' : 'Installed'}</span>`;
}
function pluginServerNames(row) {
    // Installed server identities are authoritative; a package title or an
    // unselected declaration must not hide an unrelated manual server.
    if (Array.isArray(row.server_names)) return new Set(row.server_names);
    if (row.mcps?.length) return new Set(row.mcps.map(m => m.name));
    return new Set(row.sign_in_url ? [row.name] : []);
}
function manualServers() {
    const owned = new Set(items.filter(r => r.installed).flatMap(r => [...pluginServerNames(r)]));
    return servers.filter(s => !owned.has(s.name));
}
function chips(active) {
    const count = id => id === 'plugins' ? items.filter(r => r.installed && offered(r)).length : id === 'mcp' ? manualServers().length : null;
    return `<div class="chips" role="group" aria-label="Plugin contents">${[['plugins', 'Plugins'], ['apps', 'Apps'], ['mcp', 'MCPs']].map(([id, label]) => `<button data-lane="${id}" class="${active === id ? 'on' : ''}" aria-pressed="${active === id}">${label}${count(id) === null ? '' : ` <span class="status">${count(id)}</span>`}</button>`).join('')}</div>`;
}
function bindChips(main) {
    main.querySelectorAll('[data-lane]').forEach(button => button.onclick = () => {
        lane = button.dataset.lane;
        navTo(lane === 'mcp' ? 'mcp' : 'plugins');
        if (lane === 'mcp') send({type: 'listMcp'});
    });
}
const offered = row => row.install !== 'block' && row.license !== 'Proprietary';
function renderPlugins(main) {
    if (detail && mcpEditing) { renderMcpForm(main, mcpEditing); return; }
    if (detail) { renderDetail(main); return; }
    if (directory) { renderDirectory(main); return; }
    const shown = items.filter(r => r.installed && offered(r) && `${r.display_name} ${r.summary}`.toLowerCase().includes(query.toLowerCase()));
    main.innerHTML = banner() + `<div class="page-heading"><div><h1>Plugins</h1><p class="sub">Manage plugins, skills, and MCPs.</p></div><div class="actions"><button class="secondary" id="browse-directory">Browse directory</button>${addMenu()}</div></div>` + notice() + chips(lane) + `<div class="list-toolbar"><input class="search" id="plugin-search" type="search" placeholder="Search ${lane === 'apps' ? 'apps' : 'installed plugins'}" aria-label="Search ${lane === 'apps' ? 'apps' : 'installed plugins'}" value="${esc(query)}"></div><div id="plugin-list"></div>`;
    const rows = lane === 'apps' ? shown.flatMap(r => (r.apps || []).map(app => `<article class="row"><button class="row-open" data-open="${esc(r.name)}">${appLogo(r, app)}<span class="copy"><strong>${esc(typeof app === 'string' ? app : app.name)}</strong><span class="summary">${esc(r.display_name)} · ${r.mcps?.length ? 'Uses MCP' : 'Requires a ChatGPT app connection'}</span></span></button><span class="status">${r.connected ? 'Connected' : r.install === 'block' ? 'Unavailable in DGC' : r.setup_required ? 'Setup required' : r.mcps?.length ? 'Not connected' : 'Unavailable in DGC'}</span></article>`)).join('') : shown.map(r => `<article class="row"><button class="row-open" data-open="${esc(r.name)}">${logo(r)}<span class="copy"><strong>${esc(r.display_name)}</strong><span class="summary">${esc(r.summary)}</span></span></button>${pluginControl(r)}</article>`).join('');
    $('plugin-list').innerHTML = rows || `<div class="empty">${lane === 'apps' ? 'Installed plugins have no app connections. Browse the directory to find a service.' : 'No installed plugins match. Browse the directory to install skills and tools.'}</div>`;
    if (lane === 'apps') {
        if (!rows && items.some(r => r.name === 'composio')) $('plugin-list').innerHTML = '';
        $('plugin-list').insertAdjacentHTML('afterbegin', composioPanel() + connectorPanels() + (rows ? '<h3>From installed plugins</h3><p class="note">These services are declared by installed packages. DGC connects through their MCP servers; a package declaration does not grant account access.</p>' : ''));
    }
    $('browse-directory').onclick = () => { directory = true; query = ''; render(); };
    $('plugin-search').oninput = e => { query = e.target.value; renderPlugins(main); $('plugin-search').focus(); };
    if (lane === 'plugins') {
        const retired = items.filter(r => r.installed && !offered(r));
        if (retired.length) main.insertAdjacentHTML('beforeend', `<details class="retired-plugins"><summary>Unavailable installed plugins · ${retired.length}</summary><p class="note">These older installations are no longer offered. You can review or uninstall them here.</p>${retired.map(r => `<article class="row"><button class="row-open" data-open="${esc(r.name)}">${logo(r)}<span class="copy"><strong>${esc(r.display_name)}</strong><span class="summary">${esc(r.block_reason || 'This integration is unavailable.')}</span></span></button><button class="secondary" data-uninstall="${esc(r.name)}">Uninstall</button></article>`).join('')}</details>`);
    }
    bindPlugins(main); bindChips(main); bindAddMenu(main);
}
function notice() { return pluginNotice ? `<p class="notice" role="status">${esc(pluginNotice)}${createdPath ? ' <button class="link" id="edit-created">Edit skill</button>' : ''}</p>` : ''; }
function addMenu() { return `<div class="add-wrap"><button id="add-menu" class="secondary" aria-haspopup="menu" aria-expanded="false">Add <span aria-hidden="true">⌄</span></button><div id="add-options" class="add-menu" role="menu" hidden><button role="menuitem" data-add="create">Create plugin</button><button role="menuitem" data-add="marketplace">Add a marketplace</button><button role="menuitem" data-add="mcp">Add MCP server</button><button role="menuitem" data-add="link">Install from link</button></div></div>`; }
function bindAddMenu(main) {
    const menu = $('add-options'), toggle = $('add-menu');
    if (toggle) toggle.onclick = () => { menu.hidden = !menu.hidden; toggle.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) menu.querySelector('button').focus(); };
    menu?.addEventListener('keydown', e => {
        const buttons = [...menu.querySelectorAll('button')], at = buttons.indexOf(document.activeElement);
        if (['ArrowDown','ArrowUp'].includes(e.key)) { e.preventDefault(); buttons[(at + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus(); }
        if (e.key === 'Escape') { menu.hidden = true; toggle.setAttribute('aria-expanded','false'); toggle.focus(); }
    });
    main.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
        menu.hidden = true; toggle.setAttribute('aria-expanded', 'false');
        if (b.dataset.add === 'mcp') { navTo('mcp'); mcpEditing = {}; render(); }
        else openForm(b.dataset.add);
    });
    if ($('edit-created')) $('edit-created').onclick = () => send({ type: 'editCreatedPlugin', path: createdPath });
}
function renderDirectory(main) {
    const available = items.filter(offered);
    const shown = available.filter(r => (marketFilter === 'all' || (r.marketplace || 'dgc-curated') === marketFilter) && `${r.display_name} ${r.summary} ${r.category || ''}`.toLowerCase().includes(query.toLowerCase()));
    const sources = [...new Set(available.map(r => r.marketplace || 'dgc-curated'))];
    main.innerHTML = `<div class="crumbs"><button id="directory-back">Plugins</button><span>›</span><span>Directory</span></div><div class="page-heading"><div><h1>Plugin directory</h1><p class="sub">Find skills and tools for DGC.</p></div><div class="actions">${addMenu()}</div></div>` + notice() + `<div class="directory-toolbar"><input id="directory-search" class="search" type="search" placeholder="Search plugins" aria-label="Search directory" value="${esc(query)}"><select id="market-filter" aria-label="Marketplace"><option value="all">All marketplaces</option>${sources.map(m => `<option value="${esc(m)}"${marketFilter===m?' selected':''}>${esc(m==='dgc-curated'?'DGC curated':m==='personal'?'Personal':m)}</option>`).join('')}</select><button class="secondary" id="manage-marketplaces">Manage marketplaces</button></div><div class="directory-status"><p class="note">${shown.length} of ${available.length} plugins</p></div><div class="directory-grid">${shown.map(r => `<article class="directory-card"><button class="directory-open" data-open="${esc(r.name)}">${logo(r)}<strong>${esc(r.display_name)}</strong><span>${esc(r.summary)}</span></button><div class="directory-card-footer"><span class="status">${esc(r.marketplace || 'DGC curated')} · ${esc(r.license || 'License not provided')}</span>${r.installed ? '<span class="status">Installed</span>' : `<button class="install" data-install="${esc(r.name)}"${r.install==='block'?' disabled':''}>${r.install==='block'?'Not offered':'Install'}</button>`}</div>${r.install==='block'?`<p class="note">${esc(r.block_reason)}</p>`:''}</article>`).join('') || '<p class="empty">No plugins match this search. Add a marketplace to browse another catalog.</p>'}</div>`;
    $('directory-back').onclick = () => { directory = false; query = ''; render(); };
    $('directory-search').oninput = e => { query = e.target.value; renderDirectory(main); $('directory-search').focus(); };
    $('market-filter').onchange = e => { marketFilter = e.target.value; renderDirectory(main); };
    $('manage-marketplaces').onclick = () => openForm('marketplace');
    bindPlugins(main); bindAddMenu(main);
}
function closeDialog() { modal?.remove(); modal = null; modalKind = ''; preview = null; connectingPlugin = null; operationPending = false; dialogReturn?.focus?.(); }
function dialog(kind, title, body, footer='') {
    if (!modal) dialogReturn = document.activeElement;
    modal?.remove(); modal = document.createElement('dialog'); modal.className = 'plugin-dialog'; modalKind = kind;
    modal.setAttribute('aria-labelledby','dialog-title');
    modal.innerHTML = `<div class="dialog-heading"><h2 id="dialog-title">${esc(title)}</h2><button class="icon-button" id="dialog-close" aria-label="Close">×</button></div><div class="dialog-body">${body}</div><div class="dialog-footer">${footer}<button class="secondary" id="dialog-cancel">Cancel</button></div>`;
    document.body.append(modal);
    $('dialog-close').onclick = closeDialog; $('dialog-cancel').onclick = closeDialog;
    modal.addEventListener('cancel', e => { e.preventDefault(); closeDialog(); });
    if (typeof modal.showModal === 'function') modal.showModal(); else modal.setAttribute('open','');
    bindPlugins(modal);
}
function reviewPlugin(name) {
    if (APP_CONNECTORS[name]) { openConnector(name); return; }
    reviewName = name; preview = null;
    dialog('review', 'Review plugin', '<p role="status">Reading the package and its supported contents…</p>');
    const row = items.find(item => item.name === name);
    if (row && browserPlugin(row)) decorateConnection(row, `Install ${row.display_name || row.name}`);
    send({type:'inspectPlugin',name});
}
function browserPlugin(row) {
    return !row.setup_required && (row.auth === 'browser' || [...(row.mcps || []), ...Object.values(row.server_specs || {})].some(s => /^https:\/\//.test(s.url || '')));
}
function connectionArt(row) {
    const name = row.display_name || row.name;
    const src = connectorLogos[row.name] || (row.name === 'composio' ? composioLogo : row.name === 'google-workspace' ? googleLogo : row.logo || items.find(r => r.name === row.name)?.logo || (row.name === 'figma' ? figmaLogo : ''));
    return `<div class="connection-art" aria-label="DGC and ${esc(name)}"><span class="connection-tile"><img src="${esc(dgcLogo)}" width="56" height="56" alt="DGC"></span><span class="connection-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="connection-tile">${src ? `<img src="${esc(src)}" width="56" height="56" alt="${esc(name)}">` : `<span class="status">Plugin</span>`}</span></div>`;
}
function connectionRequirement(row) {
    if (row.connected) return '';
    const remoteFigma = [...(row.mcps || []), ...Object.values(row.server_specs || {})].some(s => {
        try { return new URL(s.url).hostname === 'mcp.figma.com'; } catch { return false; }
    });
    if (!remoteFigma) return '';
    return `<div class="connection-requirement"><strong>Figma approval required</strong><p>Figma’s remote server accepts approved clients. DGC is not approved yet, so installing this plugin does not enable Figma sign-in.</p><p>${link('https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/', 'Figma connection requirements')}</p><details><summary>Can I use the desktop server?</summary><p>Figma also offers a desktop MCP server. It runs on the computer with the Figma desktop app. With Remote SSH, that connection must be forwarded to the computer running DGC.</p><p>${link('https://developers.figma.com/docs/figma-mcp-server/local-server-installation/', 'Desktop server setup')}</p></details></div>`;
}
function decorateConnection(row, title) {
    modal.classList.add('connection-dialog');
    modal.setAttribute('aria-labelledby', 'connection-title');
    modal.querySelector('.dialog-body').insertAdjacentHTML('afterbegin', connectionArt(row) + `<h2 id="connection-title" class="connection-title">${esc(title)}</h2>` + connectionRequirement(row));
    bindPlugins(modal);
}
function showConnection(row, state = 'confirm') {
    connectingPlugin = row.name;
    const title = row.display_name || row.name;
    const error = errors.get(row.name) || row.connection_error;
    const body = state === 'error' ? `<div class="banner error" role="alert"><p>${esc(error || 'The connection did not finish.')}</p></div>`
        : state === 'connected' ? `<p class="connection-intro" role="status">Connected. ${esc(title)} tools are ready for DGC.</p>`
        : state === 'browser' ? `<p class="connection-intro" role="status">Finish connecting ${esc(title)} in your browser.</p>`
        : state === 'pending' ? '<p class="connection-intro" role="status">Requesting a connection. Your browser opens only if the service provides a sign-in link.</p>'
        : `<p class="connection-intro">Connect the installed plugin to use its tools in DGC.</p>`;
    const action = state === 'connected' ? '<button class="save" id="connection-done">Done</button>'
        : state === 'browser' ? '<button class="save" data-browser>Open browser</button>'
        : state === 'pending' ? '<button class="save" disabled>Connecting…</button>'
        : `<button class="save" id="confirm-connect">${state === 'error' ? 'Try again' : 'Connect'}</button>`;
    dialog('connection', `Connect ${title}`, body, action);
    decorateConnection(row, state === 'connected' ? `${title} is connected` : `Connect ${title}`);
    if ($('confirm-connect')) $('confirm-connect').onclick = () => {
        pending.set(row.name, true); errors.delete(row.name); detail = row.name;
        showConnection({...row, connection_error: ''}, 'pending');
        send({type: 'installPlugin', name: row.name}); render();
    };
    if ($('connection-done')) $('connection-done').onclick = closeDialog;
    if (state === 'pending') $('dialog-cancel').textContent = 'Hide';
    if (state === 'browser') {
        // Dismissing progress leaves the underlying banner available; Cancel stops OAuth.
        $('dialog-cancel').onclick = () => { send({type: 'cancelSignIn'}); closeDialog(); };
    }
}
function updateConnection(state) {
    if (modalKind !== 'connection' || !connectingPlugin) return;
    const row = items.find(r => r.name === connectingPlugin);
    if (row) showConnection(row, state);
}
function renderReview(item) {
    preview = item;
    const servers = Object.entries(item.server_specs || {});
    const apps = item.apps || item.metadata?.apps || [];
    const serverLabel = name => apps.find(a => name.endsWith('--' + a.id))?.name || name;
    dialog('review', item.display_name || item.name, `<p>${esc(item.long_summary || item.summary || '')}</p>${compatibilityDetails(item)}<p class="note">Source: ${esc(item.upstream || item.marketplace || 'Local package')}${item.sha ? '<br>Revision: '+esc(item.sha.slice(0,12)) : ''}</p>${item.setup_required?`<div class="banner"><p>${esc(item.setup_instructions)}</p></div><p>${link(item.setup_url,'Google setup instructions')}</p>`:''}${item.skills?.length ? '<details class="review-section"><summary>Skills · '+item.skills.length+'</summary>'+item.skills.map(x=>`<div class="review-skill"><strong>${esc(x.name)}</strong><span>${esc(x.description)}</span></div>`).join('')+'</details>' : ''}${servers.length ? '<h3>MCP servers</h3>' + servers.map(([name,spec])=>`<label class="review-choice"><input type="checkbox" data-server="${esc(name)}" checked><span><strong>${esc(serverLabel(name))}</strong><span>${esc(spec.url || spec.command + ' ' + (spec.args || []).join(' '))}</span>${spec.env_names?.length ? '<span>Requires: '+esc(spec.env_names.join(', '))+'</span>' : ''}</span></label>`).join('') : ''}${(item.warnings || []).map(w=>`<p class="note">${esc(w)}</p>`).join('')}${!item.supported ? `<p class="error-message" role="alert">${esc(item.compatibility_reason)}</p>` : ''}<p class="note">License: ${item.license_url ? link(item.license_url, item.license || 'Publisher license') : esc(item.license || 'Not provided')}. ${item.install==='accept'?'Publisher terms are confirmed before installation.':''}${item.privacy_url ? ' '+link(item.privacy_url, 'Privacy policy') : ''}</p>`, `<button class="save" id="confirm-plugin"${item.supported?'':' disabled'}>${item.setup_required?'Install selected connections':'Install selected plugin'}</button>`);
    if (item.name === 'google-workspace') {
        const choices = servers.map(([name]) => {
            const app = apps.find(a => name.endsWith('--' + a.id));
            const src = serviceLogos[app?.id];
            return `<label class="google-choice"><span class="service-tile">${src ? `<img src="${esc(src)}" width="28" height="28" alt="">` : ''}</span><span>${esc(app?.name || name)}</span><input type="checkbox" role="switch" aria-label="${esc(app?.name || name)}" data-server="${esc(name)}" checked></label>`;
        }).join('');
        dialog('review', 'Choose Google services for DGC', `<div class="connection-art" aria-label="DGC and Google"><span class="connection-tile"><img src="${esc(dgcLogo)}" width="56" height="56" alt="DGC"></span><span class="connection-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="connection-tile"><img src="${esc(googleLogo)}" width="44" height="44" alt="Google"></span></div><h2 id="google-title">Choose Google services for DGC</h2><p class="google-intro">Select the connections you want to set up.</p><div class="google-choices">${choices}</div><div class="google-setup"><strong>Setup required</strong><p>DGC’s Google sign-in is not configured yet. Installing saves your selections. It does not grant account access.</p><details><summary>What is needed to connect?</summary><p>${esc(item.setup_instructions)}</p><p>${link(item.setup_url,'Google setup instructions')}</p><p>License: ${esc(item.license)}. Publisher terms are confirmed before installation.</p></details></div>`, '<button class="save" id="confirm-plugin">Install selected connections</button>');
        modal.classList.add('google-dialog', 'connection-dialog');
        modal.setAttribute('aria-labelledby','google-title');
    } else if (browserPlugin(item)) {
        decorateConnection(item, `Install ${item.display_name || item.name}`);
    }
    preview = item;
    $('confirm-plugin').onclick = () => {
        const selectedServers = [...modal.querySelectorAll('[data-server]:checked')].map(x=>x.dataset.server);
        if (!item.skills?.length && !selectedServers.length) return;
        pending.set(item.name,true); detail=item.name;
        // The host stores the reviewed source under the requested identity. URL installs keep that identity until resolved.
        send({type:'installPlugin', name:reviewName.startsWith('https://')?reviewName:item.name, selectedServers});
        closeDialog(); render();
        if (browserPlugin(item)) showConnection(item, 'pending');
    };
    modal.querySelectorAll('[data-server]').forEach(c=>c.onchange=()=>{ $('confirm-plugin').disabled = !item.supported || (!item.skills?.length && !modal.querySelector('[data-server]:checked')); });
}
function openForm(kind) {
    if (kind === 'marketplace') {
        dialog(kind,'Marketplaces',`<p class="note">A marketplace is a catalog of packages. Adding one makes its plugins searchable; it does not install or execute them.</p><form id="market-form"><label>GitHub repository or local folder<input id="market-source" required placeholder="owner/repository or /path/to/marketplace"></label><div class="actions"><button class="secondary" type="button" id="market-browse">Choose folder</button><button class="save">Add marketplace</button></div></form><div id="market-list">${marketplaces.map(m=>`<div class="market-row"><strong>${esc(m.display_name || m.name)}</strong><span class="note">${esc(m.source)} · ${esc(m.pin?.slice(0,12))}</span><div class="actions"><button class="secondary" data-market-refresh="${esc(m.name)}">Refresh</button><button class="secondary" data-market-remove="${esc(m.name)}">Remove</button></div></div>`).join('') || '<p class="note">DGC curated is included. No additional marketplaces yet.</p>'}</div>`);
        $('market-browse').onclick=()=>send({type:'browseMarketplace'});
        $('market-form').onsubmit=e=>{e.preventDefault(); operationPending=true; send({type:'marketplaceAction',action:'add',source:$('market-source').value.trim()}); statusDialog('Fetching and checking the marketplace…');};
        modal.querySelectorAll('[data-market-refresh],[data-market-remove]').forEach(b=>b.onclick=()=>{operationPending=true; send({type:'marketplaceAction',action:b.dataset.marketRefresh?'refresh':'remove',name:b.dataset.marketRefresh||b.dataset.marketRemove});statusDialog('Updating marketplace…');});
    } else if (kind === 'create') {
        dialog(kind,'Create plugin',`<p class="note">Create a local package and starter skill. It appears under Personal in the directory. Nothing runs until you install it.</p><form id="create-form"><label>Name<input id="create-name" required pattern="[a-z0-9][a-z0-9-]{0,63}" placeholder="my-plugin"></label><label>Display name<input id="create-display" maxlength="100" required></label><label>When should DGC use it?<textarea id="create-description" maxlength="500" required></textarea></label><button class="save">Create plugin</button></form>`);
        $('create-form').onsubmit=e=>{e.preventDefault();send({type:'createPlugin',name:$('create-name').value,displayName:$('create-display').value,description:$('create-description').value});operationPending=true;statusDialog('Creating plugin…');};
    } else {
        dialog('link','Install from link','<p class="note">Paste a public GitHub repository or plugin folder. DGC pins the fetched revision and shows its contents before installation.</p><form id="link-form"><label>Plugin URL<input id="plugin-link" type="url" required placeholder="https://github.com/…"></label><button class="save">Review plugin</button></form>');
        $('link-form').onsubmit=e=>{e.preventDefault();reviewPlugin($('plugin-link').value.trim());};
    }
}
function statusDialog(message, error=false) {
    if (!modal) return;
    let el=modal.querySelector('.dialog-status');
    if (!el) { el=document.createElement('p'); el.className='dialog-status'; el.setAttribute('role','status'); modal.querySelector('.dialog-body').append(el); }
    el.textContent=message; el.classList.toggle('error-message',error);
    modal.querySelectorAll('form button,[data-market-refresh],[data-market-remove]').forEach(b=>b.disabled=operationPending);
}
function composioPanel(inDetail = false) {
    const row = items.find(r => r.name === 'composio');
    if (!row || (!inDetail && !('composio '+row.summary).toLowerCase().includes(query.toLowerCase()))) return '';
    const controls = !row.installed ? '<button class="save" data-install="composio">Connect Composio</button>' : row.connected
        ? '<span class="status connected">Account connected</span>' : '<button class="save" data-connect="composio">Connect account</button>';
    return `<section class="connector-panel" aria-label="Composio app connector"><div class="connector-heading">${inDetail ? '' : logo(row)}<div class="copy"><h3>Composio</h3><p>App connector · Use your own account to connect apps to DGC.</p></div><div class="actions">${controls}</div></div><p>Connect and manage your apps in <strong>Composio For You → Connect Apps</strong>. Then return to DGC and ask it to use the app.</p><div class="actions"><button class="secondary" data-composio-catalog>Manage apps in Composio</button>${!inDetail ? '<button class="link" data-open="composio">Connector details</button>' : ''}</div><p class="note">App connections, permissions and revocation are managed in Composio. DGC shows the connector’s status here; individual app status is shown in Composio.</p><p class="note">Composio handles app credentials and runs app requests in its cloud, even with a local model. Uninstalling the connector does not revoke app permissions.</p></section>`;
}
function connectorPanels(only = '') {
    return Object.entries(APP_CONNECTORS).filter(([id]) => (!only || only === id) && (only || (id+' '+APP_CONNECTORS[id].summary).toLowerCase().includes(query.toLowerCase())) && items.some(r => r.name === id)).map(([id,def]) => {
        const row=items.find(r=>r.name===id);
        const state=servers.find(r=>r.name===id);
        return `<section class="connector-panel" aria-label="${esc(def.name)} connector"><div class="connector-heading">${logo(row)}<div class="copy"><h3>${esc(def.name)}</h3><p>${esc(def.kind)} · ${esc(def.summary)}</p></div><span class="status${row.connected ? ' connected' : ''}">${row.connected ? 'Connected' : row.installed ? state?.enabled === false ? 'Disabled' : 'Not connected' : 'Not connected'}</span></div><div class="actions"><button class="${row.connected ? 'secondary' : 'save'}" data-connector-setup="${id}">${row.connected ? 'Configure' : 'Connect '+esc(def.name)}</button><button class="secondary" data-connector-manage="${id}">${id==='n8n' && !row.installed ? 'Setup instructions' : def.kind==='Workflow connector' ? 'Manage workflows' : 'Manage apps'}</button>${!only ? `<button class="link" data-open="${id}">Details</button>` : ''}${row.installed ? `<button class="link" data-uninstall="${id}">Disconnect</button>` : ''}</div>${row.connection_error ? `<p class="error-message" role="status">${esc(row.connection_error)}</p>` : ''}</section>`;
    }).join('');
}
function openConnector(id) {
    const def=APP_CONNECTORS[id]; if(!def)return;
    const row=items.find(r=>r.name===id) || {name:id,display_name:def.name};
    const server=servers.find(s=>s.name===id);
    const url=server?.url || row.mcps?.[0]?.url || def.url;
    dialog('connector', 'Connect '+def.name, `${connectionArt(row)}<h2 class="connection-title" id="connector-title">Connect ${esc(def.name)}</h2><p>${esc(def.setup)}</p><p>${link(def.docs,'Setup instructions')} · ${link(def.terms,'Terms')} · ${link(def.privacy,'Privacy')}</p><form id="connector-form">${def.url ? `<p class="note">Server: ${esc(def.url)}</p>` : `<label>${id==='arcade'?'Gateway URL':'Instance MCP URL'}<input id="connector-url" type="url" required autocomplete="off" placeholder="${esc(def.placeholder)}" value="${esc(url)}"></label>`}<label>Authentication<select id="connector-auth">${def.auth.map(a=>`<option value="${a}"${a==='token' && server?.auth_env ? ' selected' : ''}>${a==='oauth'?'Browser sign-in':'Connection token'}</option>`).join('')}</select></label><label id="connector-token-field">Connection token<input id="connector-token" type="password" autocomplete="off" spellcheck="false" placeholder="${row.installed?'Leave blank to keep the saved token':'Paste the token from '+esc(def.name)}"></label><p class="note">Pasted tokens are kept in the editor’s secret storage. Browser sign-in tokens are managed by the local MCP bridge. App credentials and permissions are managed by ${esc(def.name)}. Disconnecting DGC does not revoke provider grants.</p><button class="save" id="connector-submit">${row.installed?'Save and connect':'Connect '+esc(def.name)}</button></form>`);
    modal.classList.add('connection-dialog');
    modal.dataset.connector = id;
    modal.setAttribute('aria-labelledby','connector-title');
    const sync=()=>{$('connector-token-field').hidden=$('connector-auth').value!=='token';};
    $('connector-auth').onchange=sync;sync();
    $('connector-form').onsubmit=e=>{
        e.preventDefault(); if(operationPending)return;
        operationPending=true;
        send({type:'saveConnector',name:id,url:$('connector-url')?.value || def.url,auth:$('connector-auth').value,token:$('connector-token').value});
        $('connector-token').value='';
        statusDialog('Connecting…');$('dialog-cancel').textContent='Hide';
    };
}
function bindPlugins(main) {
    main.querySelectorAll('[data-connector-setup]').forEach(b => b.onclick = () => openConnector(b.dataset.connectorSetup));
    main.querySelectorAll('[data-connector-manage]').forEach(b => b.onclick = () => send({type:'connectorManage',name:b.dataset.connectorManage}));
    main.querySelectorAll('[data-mcp-toggle]').forEach(b => b.onclick = () => { b.disabled = true; send({ type: 'mcpToggle', name: b.dataset.mcpToggle, enabled: b.getAttribute('aria-checked') !== 'true' }); });
    main.querySelectorAll('[data-mcp-edit]').forEach(b => b.onclick = () => { if (APP_CONNECTORS[b.dataset.mcpEdit]) { openConnector(b.dataset.mcpEdit); return; } mcpEditing = servers.find(s => s.name === b.dataset.mcpEdit); render(); });
    main.querySelectorAll('[data-composio-catalog]').forEach(b => b.onclick = () => send({type:'composioCatalog'}));
    main.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { detail = b.dataset.open; render(); $('main').scrollTop = 0; });
    main.querySelectorAll('[data-install]').forEach(b => b.onclick = () => reviewPlugin(b.dataset.install));
    main.querySelectorAll('[data-connect]').forEach(b => b.onclick = () => { const row=items.find(r=>r.name===b.dataset.connect); if(row) APP_CONNECTORS[row.name] ? openConnector(row.name) : showConnection(row); });
    main.querySelectorAll('[data-uninstall]').forEach(b=>b.onclick=()=>{operationPending=true;b.disabled=true;send({type:'uninstallPlugin',name:b.dataset.uninstall});});
    main.querySelectorAll('[data-plugin]').forEach(b => b.onclick = () => { const row = items.find(r => r.name === b.dataset.plugin), enabled = !row.skills.every(s => s.enabled !== false); row.skills.filter(s => (s.enabled !== false) !== enabled).forEach(s => { skillPending.set(s.name, enabled); send({ type: 'skillToggle', name: s.name, enabled }); }); render(); });
    main.querySelectorAll('[data-skill]').forEach(b => b.onclick = () => { const enabled = b.getAttribute('aria-checked') !== 'true'; skillPending.set(b.dataset.skill, enabled); send({ type: 'skillToggle', name: b.dataset.skill, enabled }); b.disabled = true; });
    main.querySelectorAll('[data-browser]').forEach(b => b.onclick = () => send({ type: 'openSignIn' }));
    main.querySelectorAll('[data-desktop-setup]').forEach(b => b.onclick = openDesktopSetup);
    main.querySelectorAll('[data-cancel-connect]').forEach(b => b.onclick = () => { send({ type: 'cancelSignIn' }); });
    main.querySelectorAll('a[data-external]').forEach(a => a.onclick = e => { e.preventDefault(); send({ type: 'openPluginLink', url: a.getAttribute('href') }); });
    main.querySelectorAll('img.logo').forEach(img => img.onerror = () => { img.replaceWith(Object.assign(document.createElement('span'), { className: 'mark' })); });
}
function link(url, text) { if (!url)
    return 'Not provided'; return /^https?:\/\//.test(url || '') ? `<a href="${esc(url)}" data-external>${esc(text || url)}</a>` : esc(text || url || 'Not provided'); }
function compatibilityDetails(row) {
    return (row.requirements ? `<p class="note"><strong>Requirements.</strong> ${esc(row.requirements)}</p>` : '')
        + (row.verification ? `<p class="note"><strong>Checked${row.audited_on ? ' ' + esc(row.audited_on) : ''}.</strong> ${esc(row.verification)}</p>` : '')
        + (row.compatibility_url ? `<p>${link(row.compatibility_url, 'Connection requirements')}</p>` : '')
        + (row.name === 'figma' ? '<button class="secondary" data-desktop-setup>Set up Figma desktop</button>' : '');
}
function openDesktopSetup() {
    dialog('desktop', 'Figma desktop connection', `<p>The desktop server is a separate connection for reading designs. It does not provide remote-only tools such as <code>use_figma</code> or <code>create_new_file</code>.</p><ol><li>Install and open the Figma desktop app. Desktop MCP requires a Dev or Full seat on a paid plan.</li><li>Open a design file, enter Dev Mode with Shift+D, and enable the desktop MCP server.</li><li>Connect DGC to <code>http://127.0.0.1:3845/mcp</code>.</li></ol><p>With Remote SSH, this address refers to the computer running DGC. Forward the desktop computer’s port to that host over SSH first. Keep it on loopback; do not expose it to the network.</p><p>${link('https://developers.figma.com/docs/figma-mcp-server/local-server-installation/', 'Figma desktop setup')}</p>`, '<button class="save" id="configure-desktop">Configure MCP server</button>');
    decorateConnection({name:'figma', display_name:'Figma desktop'}, 'Connect Figma desktop');
    $('configure-desktop').onclick = () => {
        closeDialog();
        navTo('mcp');
        mcpEditing = {transport:'remote', suggested_name:'figma-desktop', url:'http://127.0.0.1:3845/mcp', setup_note:'Enable Figma desktop MCP first. With Remote SSH, forward port 3845 to the DGC host. No browser sign-in or bearer token is needed for this local server.'};
        render();
    };
}
function renderDetail(main) {
    const row = items.find(r => r.name === detail);
    if (!row) {
        detail = '';
        renderPlugins(main);
        return;
    }
    const skills = row.skills || [], apps = row.apps || [], mcps = row.mcps || [];
    const connections = servers.filter(s => pluginServerNames(row).has(s.name));
    main.innerHTML = `<div class="crumbs"><button id="back">Plugins</button><span aria-hidden="true">›</span><span>${esc(row.display_name)}</span></div>` + banner(row) + issue(row) + `<div class="hero">${logo(row, true)}<div class="copy"><h1>${esc(row.display_name)}</h1><p class="sub">${esc(row.summary)}</p></div><div class="actions">${pluginControl(row)}${row.installed && offered(row) && mcps.length && !row.setup_required && !row.connected && !pending.has(row.name) && !row.opening ? `<button class="install" data-connect="${esc(row.name)}">Connect</button>` : ''}${row.installed ? `<button class="secondary" data-uninstall="${esc(row.name)}">Uninstall</button>` : ''}</div></div>${row.connected ? '<p class="status connected">Connected</p>' : ''}${row.install === 'block' ? `<p class="note">${esc(row.block_reason)}</p>` : ''}`
        + compatibilityDetails(row) + (row.setup_required && !row.connected ? `<div class="banner"><p>${esc(row.setup_instructions || 'Complete Google Cloud and OAuth setup before connecting.')}</p></div><p>${link(row.setup_url,'Setup instructions')}</p>` : '') + ((row.default_prompt || []).length ? `<div class="examples">${row.default_prompt.slice(0, 3).map(p => `<div class="example">${esc(p)}</div>`).join('')}</div>` : '') + `<p class="long-description">${esc(row.long_summary || row.summary)}</p>`
        + '<h3>Apps' + (apps.length ? ' · ' + apps.length : '') + '</h3>' + (apps.length ? apps.map(app => `<div class="row">${appLogo(row, app)}<span class="copy"><strong>${esc(typeof app === 'string' ? app : app.name)}</strong><span class="description">${mcps.length ? 'DGC connects to this service through the plugin’s MCP server.' : 'This package expects a ChatGPT app connection. It is unavailable in DGC without a standalone MCP server.'}</span></span></div>`).join('') : '<p class="note">No apps declared in this package.</p>')
        + `<h3>Skills${skills.length ? ' · ' + skills.length : ''}</h3>` + (skills.length ? skills.map(s => `<div class="row"><span class="copy"><strong>${esc(s.name)}</strong><span class="description skill-description" title="${esc(s.description)}">${esc(s.description || 'No description provided.')}</span></span>${row.installed && offered(row) ? switchHTML(s.enabled !== false, `Enable ${s.name}`, `data-skill="${esc(s.name)}"`, skillPending.has(s.name)) : ''}</div>`).join('') : '<p class="note">No instruction skills in this package.</p>')
        + `<h3>Information</h3><dl class="meta">${[['Developer', esc(row.developer || 'Not provided')], ['Category', esc(row.category || 'Not provided')], ['License', row.license_url && (!row.declared_license || row.declared_license === row.license) ? link(row.license_url, row.license || 'License') : esc(row.declared_license || row.license || 'Not provided')], ['Version', esc(row.version || 'Not provided')], ['Terms', link(row.terms_url, 'Publisher terms')], ['Privacy', link(row.privacy_url, 'Privacy policy')], ['Website', link(row.website_url)], ['MCP URL', mcps.length ? mcps.map(m => m.url ? link(m.url) : esc(m.command || m.transport)).join('<br>') : 'None declared'], ['Source', link(row.source_url || row.upstream)]].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
    if (row.installed && offered(row) && connections.length) {
        main.querySelector('.meta').previousElementSibling.insertAdjacentHTML('beforebegin', '<section class="plugin-connections"><h3>Connection</h3>' + serverRows(connections) + '</section>');
    }
    if (row.name === 'composio') main.querySelector('.hero').insertAdjacentHTML('afterend', composioPanel(true));
    if (APP_CONNECTORS[row.name]) main.querySelector('.hero').insertAdjacentHTML('afterend', connectorPanels(row.name));
    $('back').onclick = () => { detail = ''; render(); };
    bindPlugins(main);
}
function serverRows(list) {
    return list.map(s => `<article class="row"><span class="mark">${icon('mcp')}</span><span class="copy"><strong>${esc(s.name)}</strong><span class="summary">${esc(s.url || s.command || 'MCP server')} · ${esc(s.state || 'Configured')}${s.tool_count ? ' · ' + s.tool_count + ' tools' : ''}</span>${s.error ? `<span class="description">${esc(s.error)}</span>` : ''}</span><div class="actions">${switchHTML(s.enabled !== false, `Enable ${s.name}`, `data-mcp-toggle="${esc(s.name)}"`)}<button class="icon-button" aria-label="Configure ${esc(s.name)}" data-mcp-edit="${esc(s.name)}">${icon('gear')}</button></div></article>`).join('');
}
function renderMcp(main) {
    if (mcpEditing) {
        renderMcpForm(main, mcpEditing);
        return;
    }
    const user = manualServers();
    const ownSignin = signin && user.some(s => s.name === signin.server) ? banner() : '';
    main.innerHTML = ownSignin + (mcpError ? '<div class="banner error" role="alert"><p>' + esc(mcpError) + '</p></div>' : '') + '<h1>MCP servers</h1><p class="sub">Servers you add yourself, using a URL or a local command.</p>' + chips('mcp') + '<div class="section-head"><h3>Your servers</h3><button class="secondary" id="add-mcp">Add server</button></div>' + (serverRows(user) || '<p class="empty">No servers added manually. Add a server using its URL and authentication details, or a local command.</p>') + '<p class="note">Manage connections installed by plugins on each plugin’s page.</p><button class="secondary" id="refresh-mcp">Refresh</button>';
    bindChips(main);
    $('add-mcp').onclick = () => { mcpEditing = {}; render(); };
    $('refresh-mcp').onclick = () => send({ type: 'listMcp' });
    bindPlugins(main);
}
function renderMcpForm(main, s) {
    const remote = s.transport === 'remote';
    main.innerHTML = `<div class="crumbs"><button id="mcp-back">${esc(detail ? items.find(r => r.name === detail)?.display_name || 'Plugin' : 'MCP servers')}</button><span>›</span><span>${esc(s.name || 'Add server')}</span></div><h1>${s.name ? 'Configure server' : 'Add server'}</h1><p class="sub">Use your existing MCP configuration and credential storage.</p>${s.setup_note ? `<p class="note">${esc(s.setup_note)}</p>` : ''}<form class="mcp-form" id="mcp-form"><label>Server name<input id="mcp-name" required pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" value="${esc(s.name || s.suggested_name)}"></label><label>Transport<select id="mcp-transport"><option value="stdio">Local STDIO</option><option value="remote"${remote ? ' selected' : ''}>Remote HTTP</option></select></label><label><span id="mcp-target-label">${remote ? 'Server URL' : 'Command'}</span><input id="mcp-target" required value="${esc(remote ? s.url : s.command)}"></label><label id="args-label">Arguments <span class="note">One per line. No shell parsing.</span><textarea id="mcp-args">${esc((s.args || []).join('\n'))}</textarea></label><label id="env-label">Environment <span class="note">KEY=value goes to SecretStorage. KEY uses the environment.</span><textarea id="mcp-env" placeholder="${esc((s.env_names || []).join('\n'))}"></textarea></label><label id="token-label">Bearer token <span class="note">Leave blank to keep the saved token.</span><input type="password" id="mcp-token" autocomplete="off"></label><label>Log level<select id="mcp-log">${['warning', 'info', 'debug', 'error', 'off'].map(v => `<option${v === s.log_level ? ' selected' : ''}>${v}</option>`).join('')}</select></label><label class="check"><input type="checkbox" id="mcp-clear">Clear stored credentials before saving</label><div class="actions"><button class="save">Save and connect</button><button type="button" class="secondary" id="mcp-cancel">Cancel</button>${s.name ? '<button type="button" class="secondary" id="mcp-reconnect">Reconnect</button><button type="button" class="secondary" id="mcp-remove">Remove server</button>' : ''}</div></form>`;
    const back = () => { mcpEditing = null; render(); };
    $('mcp-back').onclick = back;
    $('mcp-cancel').onclick = back;
    const transport = () => { const remote = $('mcp-transport').value === 'remote'; $('args-label').hidden = remote; $('env-label').hidden = remote; $('token-label').hidden = !remote; $('mcp-target-label').textContent = remote ? 'Server URL' : 'Command'; };
    $('mcp-transport').onchange = transport;
    transport();
    $('mcp-form').onsubmit = e => { e.preventDefault(); send({ type: 'mcpSave', values: { original_name: s.name || '', name: $('mcp-name').value, transport: $('mcp-transport').value, target: $('mcp-target').value, args: $('mcp-args').value, env: $('mcp-env').value, env_names: s.env_names || [], token: $('mcp-token').value, clear_secrets: $('mcp-clear').checked, log_level: $('mcp-log').value } }); };
    if (s.name) {
        $('mcp-reconnect').onclick = () => send({ type: 'mcpReconnect', name: s.name });
        $('mcp-remove').onclick = () => send({ type: 'mcpRemove', name: s.name });
    }
}
document.querySelector('nav').innerHTML = sections.map(([id, label], i) => (i === 5 ? '<div class="nav-divider"></div>' : '') + `<button data-nav="${id}" title="${label}">${icon(id)}<span class="nav-text">${label}</span></button>`).join('');
document.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => { navTo(b.dataset.nav); if (b.dataset.nav === 'mcp')
    send({ type: 'listMcp' }); });
$('collapse-nav').innerHTML = icon('panel');
$('collapse-nav').onclick = () => { const collapsed = document.querySelector('.shell').classList.toggle('collapsed'); $('collapse-nav').setAttribute('aria-expanded', String(!collapsed)); $('collapse-nav').setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation'); };
window.addEventListener('message', event => {
    const msg = event.data || {};
    if (msg.type === 'show') {
        navTo(msg.section, msg.range);
    }
    else if (msg.type === 'providers') {
        providers = msg.providers || [];
        if (config && !dirty.size)
            render();
    }
    else if (msg.type === 'plugins') {
        items = Array.isArray(msg.items) ? msg.items : [];
        for (const r of items) {
            if (r.connected)
                pending.delete(r.name);
            for (const s of r.skills || [])
                if (skillPending.get(s.name) === (s.enabled !== false))
                    skillPending.delete(s.name);
            if (r.connected && (signin?.server === r.name || r.server_names?.includes(signin?.server)))
                signin = null;
        }
        if (items.some(r => r.name === connectingPlugin && r.connected)) updateConnection('connected');
        if (['plugins', 'mcp'].includes(section) && !mcpEditing)
            render();
    }
    else if (msg.type === 'pluginPreview') {
        if (modalKind === 'review' && reviewName === msg.requested) renderReview(msg.item);
    }
    else if (msg.type === 'marketplaces') { marketplaces=msg.items || []; if (modalKind === 'marketplace' && !operationPending) openForm('marketplace'); }
    else if (msg.type === 'marketplaceFolder') { if ($('market-source')) $('market-source').value=msg.path; }
    else if (msg.type === 'pluginOperation') {
        operationPending=false; pluginNotice=msg.message; createdPath=msg.path || ''; closeDialog();
        if (msg.action==='uninstall_plugin') detail='';
        if (msg.action==='create_plugin') {directory=true;marketFilter='personal';query='';}
        if (['plugins','mcp'].includes(section)) render();
    }
    else if (msg.type === 'pluginOperationCancelled') { operationPending=false; if (modal) statusDialog('Cancelled.'); else render(); }
    else if (msg.type === 'pluginOperationError') {
        operationPending=false; pluginNotice=msg.message;
        if (modal) statusDialog(msg.message,true); else if (['plugins','mcp'].includes(section)) render();
    }
    else if (msg.type === 'signin') {
        signin = msg.clear ? null : msg;
        if (modalKind === 'connector' && signin?.server === modal.dataset.connector) {
            statusDialog('Finish connecting '+APP_CONNECTORS[signin.server].name+' in your browser.');
            if (!modal.querySelector('[data-browser]')) {
                modal.querySelector('.dialog-body').insertAdjacentHTML('beforeend','<button class="secondary" data-browser>Open browser</button>');
                modal.querySelector('[data-browser]').onclick=()=>send({type:'openSignIn'});
            }
            $('dialog-cancel').textContent='Cancel';
            $('dialog-cancel').onclick=()=>{send({type:'cancelSignIn'});closeDialog();};
        }
        if (signin && items.some(r => r.name === connectingPlugin && (r.name === signin.server || r.server_names?.includes(signin.server)))) updateConnection('browser');
        if (['plugins', 'mcp'].includes(section) && !mcpEditing)
            render();
    }
    else if (msg.type === 'pluginResult') {
        pending.delete(msg.name);
        if (msg.error)
            errors.set(msg.name, msg.error);
        if (msg.name === connectingPlugin && msg.error) updateConnection('error');
        if (['plugins', 'mcp'].includes(section))
            render();
    }
    else if (msg.type === 'settingsSaved') {
        saving = false;
        saveStatus = msg.ok ? 'Saved' : msg.message || 'Save did not finish. Review your changes.';
        if (msg.ok) {
            dirty.clear();
            draft.api_key = draft.subagent_api_key = draft.fallback_api_key = '';
        }
        if (['general', 'models', 'agents', 'security'].includes(section))
            render();
    }
    else if (msg.type === 'settingsSaveFinished') {
        if (saving) {
            saving = false;
            saveStatus = 'Save cancelled. Your edits are still here.';
            if (['general', 'models', 'agents', 'security'].includes(section))
                render();
        }
    }
    else if (msg.type === 'usage_unavailable') {
        usage?.unavailable(msg);
    }
    else if (msg.type === 'connectorError') { statusDialog(msg.message,true); }
    else if (msg.type === 'connectorSaveFinished') { operationPending=false; if(modalKind==='connector') { modal.querySelectorAll('form button').forEach(b=>b.disabled=false); $('dialog-cancel').textContent='Close'; $('dialog-cancel').onclick=closeDialog; modal.querySelector('[data-browser]')?.remove(); } }
    else if (msg.type === 'mcpSaved') {
        if (msg.ok) {
            if (modalKind === 'connector') closeDialog();
            mcpEditing = null;
            send({ type: 'listMcp' });
            render();
        }
    }
    else if (msg.type === 'event') {
        const ev = msg.event || {};
        if (ev.type === 'config')
            applyConfig(ev);
        else if (ev.type === 'usage_report')
            usage?.receive(ev);
        else if (ev.type === 'mcp_servers') {
            servers = ev.items || [];
            const connected = new Set(servers.filter(s => s.state === 'connected').map(s => s.name));
            items = items.map(r => { const names=r.server_names || (r.mcps || []).map(m => m.name); return names.length ? {...r,connected:names.every(n => connected.has(n))} : r; });
            mcpError = ev.error || '';
            if (['plugins', 'mcp'].includes(section) && !mcpEditing)
                render();
        }
        else if (ev.type === 'command_rejected') {
            skillPending.clear();
            if (ev.command === 'set_skill_enabled') {
                if (detail)
                    errors.set(detail, ev.message);
                if (section === 'plugins')
                    render();
            }
            else if (ev.command === 'get_usage')
                usage?.unavailable({ requestId: ev.request_id, message: ev.message });
            else if (section === 'mcp') {
                mcpError = ev.message || 'The server could not be updated.';
                render();
            }
        }
    }
});
render();
send({ type: 'ready' });

document.addEventListener('pointerdown', event => { if (!event.target.closest('.add-wrap')) { const menu=$('add-options'); if (menu) menu.hidden=true; $('add-menu')?.setAttribute('aria-expanded','false'); } });
