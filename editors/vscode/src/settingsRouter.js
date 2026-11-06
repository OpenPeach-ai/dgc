// Settings -> Models -> DGC Router: the switch, the Systems list and everything a system card does (Test, Suggest,
// Edit, Remove), + Add system and Look on my network. Every change is made at once through the backend's router_*
// commands (ready.capabilities.router), never with the page's Save all; the list follows router_status and
// router_changed live. Keys and pairing tokens go to DGC once (router_update set_key, router_hardware token) and are
// never sent back: the page only learns has_key / hardware.has_token.
import { bindContextCombos, contextComboHTML, parseContext } from './contextCombo.js';

// The ports a look on the network checks: dgc/router_probe.py KNOWN_PORTS (8188 is ComfyUI, for image generation).
const ROUTER_PORTS = '11434, 8080, 1234, 8000, 30000, 8188';
const SERVER_NAMES = { ollama: 'Ollama', llamacpp: 'llama.cpp', vllm: 'vLLM', sglang: 'SGLang', tgi: 'TGI', lmstudio: 'LM Studio',
    openai_compatible: 'OpenAI-compatible', comfyui: 'ComfyUI' };
const JOB_NAMES = { subagents: 'Sub-agents', pips: 'Pips' };

const GB = 1024 ** 3;
const gb = (bytes) => { const g = bytes / GB; return g >= 10 ? String(Math.round(g)) : g.toFixed(1).replace(/\.0$/, ''); };
/** What a context costs on a system, as Suggest counts it (dgc/router_suggest.py; the status carries its facts):
 *  "≈ 4.4 GB each · 2 workers ≈ 8.8 GB of 54 GB free", or one line saying it won't fit. "" when DGC doesn't know
 *  the model's context memory. `system`: the status row; `model`: its row or an offered one. */
export function contextCost(system, model, tokens, workers) {
    const kv = Number(model?.kv_bytes_per_token) || 0;
    if (!kv || !(tokens > 0)) return '';
    const each = kv * tokens, n = Math.max(1, Number(workers) || 1), all = each * n;
    const head = `≈ ${gb(each)} GB each · ${n} worker${n === 1 ? '' : 's'} ≈ ${gb(all)} GB`;
    const total = Number(system?.memory?.total_bytes) || 0;
    if (!total) return head;
    const free = total - (Number(system.memory.kept_free_bytes) || 0) - (Number(model?.weights_bytes) || 0);
    if (all > free) return `Won't fit: ${n} worker${n === 1 ? '' : 's'} need ≈ ${gb(all)} GB and ${gb(Math.max(0, free))} GB is free (saving still works).`;
    return `${head} of ${gb(free)} GB free`;
}

export function tokensShort(n) {
    const tokens = Math.max(0, Math.floor(Number(n) || 0));
    if (tokens >= 1048576 && tokens % 1048576 === 0) return `${tokens / 1048576}M`;
    return tokens >= 1024 ? `${Math.round(tokens / 1024)}K` : String(tokens);
}
/** "32B Q4", "9.7B", "cloud": a model's size in two words, from what the server said. */
export function sizeWords(model) {
    const parts = [];
    const params = Number(model?.params_b);
    if (params > 0) parts.push(`${params >= 10 ? Math.round(params) : Math.round(params * 10) / 10}B`);
    const quant = String(model?.quant || '').toUpperCase().match(/^(Q\d|IQ\d|F16|BF16|FP16|F32|FP8|INT4|INT8|MXFP4|NVFP4)/);
    if (quant) parts.push(quant[1]);
    if (model?.cloud) parts.push('cloud');
    return parts.join(' ');
}
/** The most context the used models can hold at once on this system: with one model at a time, the largest any one
 *  model holds; otherwise the system's workers spread over its models, largest contexts first.
 *  {parts: [[workers, context]], total} or null when no model is used. */
export function totalContext(system) {
    const used = (system?.models || []).filter(m => m.use !== false && Number(m.workers) > 0 && Number(m.context) > 0);
    if (!used.length) return null;
    const cap = Math.max(1, Number(system.workers) || 1);
    if (system.one_model_at_a_time) {
        let best = null;
        for (const m of used) {
            const n = Math.min(Number(m.workers), cap), total = n * Number(m.context);
            if (!best || total > best.total) best = { parts: [[n, Number(m.context)]], total };
        }
        return best;
    }
    let left = cap;
    const parts = [];
    for (const m of [...used].sort((a, b) => Number(b.context) - Number(a.context))) {
        const n = Math.min(Number(m.workers), left);
        if (n > 0) { parts.push([n, Number(m.context)]); left -= n; }
    }
    return { parts, total: parts.reduce((sum, [n, c]) => sum + n * c, 0) };
}
/** "Total: 3 × 64K = 192K context" */
export function totalLine(total) {
    if (!total) return '';
    const sum = total.parts.map(([n, c]) => `${n} × ${tokensShort(c)}`).join(' + ');
    return `Total: ${sum}${total.parts.length > 1 || total.parts[0][0] > 1 ? ` = ${tokensShort(total.total)}` : ''} context`;
}
/** What the server itself says about room for that, when it says: llama.cpp's slots and their context, vLLM's and
 *  SGLang's context memory, TGI's requests at once. {ok, text} or null (Ollama and LM Studio don't say: Test measures). */
export function roomCheck(system, total) {
    if (!total) return null;
    const workers = total.parts.reduce((sum, [n]) => sum + n, 0);
    const largest = Math.max(...total.parts.map(([, c]) => c));
    const kv = Number(system?.server_kv_tokens) || 0, slots = Number(system?.server_slots) || 0;
    const slotContext = Number(system?.server_slot_context) || 0;
    if (kv) {
        const ok = total.total <= kv;
        return { ok, text: ok ? `server has room for ${tokensShort(kv)} ✓` : `server holds ${tokensShort(kv)} of context ✗` };
    }
    if (slots) {
        const ok = workers <= slots && (!slotContext || largest <= slotContext);
        const what = `server: ${slots} slot${slots === 1 ? '' : 's'}${slotContext ? ` of ${tokensShort(slotContext)}` : ''}`;
        return { ok, text: `${what} ${ok ? '✓' : '✗'}` };
    }
    return null;
}
/** One model's last test: "41 tok/s · first token 320 ms · 2 at once · tool calls ✓". */
export function testWords(model) {
    const bits = [];
    // Only what Test measured: whether a model calls tools is also known from the server, which is no test.
    if (!(Number(model?.tokens_per_s) > 0 || Number(model?.parallel) > 0 || Number(model?.speed_at) > 0)) return '';
    if (Number(model?.tokens_per_s) > 0) bits.push(`${Math.round(Number(model.tokens_per_s) * 10) / 10} tok/s`);
    if (Number(model?.ttft_ms) > 0) bits.push(`first token ${Math.round(Number(model.ttft_ms))} ms`);
    if (Number(model?.parallel) > 0) bits.push(`${model.parallel} at once`);
    if (model?.tools === true) bits.push('tool calls ✓');
    else if (model?.tools === false) bits.push('tool calls ✗');
    return bits.join(' · ');
}
/** How long ago, said as a person would: "just now" only in its first minute, then whole minutes, hours or days. */
export function ago(seconds) {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - Number(seconds)));
    if (!Number.isFinite(s)) return '';
    return s < 60 ? 'just now' : s < 5400 ? `${Math.floor(s / 60)} min ago` : s < 172800 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} days ago`;
}
function clock(seconds) {
    const d = new Date(Number(seconds) * 1000);
    return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
}
/** The address a person reads: host and port, no scheme. */
export function shortAddress(url) {
    try { const u = new URL(url); return u.host + (u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/+$/, '') : ''); } catch { return String(url || ''); }
}
/** The systems that do sub-agent work right now, and their free workers: the Sub-agents block's one line. */
/** The models a system's server serves, as rows for its form when DGC chose none (nothing was loaded when it was added,
 *  or its key only just let DGC read it). Ticked only if it is loaded there now, as DGC's own Add does
 *  (router_tools.suggest_models): never a cloud or embedding model, and on a server that loads models when asked
 *  (Ollama, LM Studio) never one it would load. A server that serves one model and doesn't say: that one. The person
 *  ticks the rest. Loaded first, then the smallest, cloud last, at most 8. */
export function offeredRows(available, server = '', limit = 8) {
    const cloud = m => !!m.cloud || /[:-]cloud$/.test(String(m.name || ''));
    const chat = (available || []).filter(m => m && m.name && m.kind !== 'embedding');
    const local = chat.filter(m => !cloud(m) && m.tools !== false);
    const loads = ['ollama', 'lmstudio'].includes(server);
    const tick = m => local.includes(m) && (!!m.loaded || (!loads && local.length === 1));
    const size = m => Number(m.params_b) || Infinity;
    return chat.map((m, i) => ({ m, i })).sort((a, b) => (!a.m.loaded - !b.m.loaded) || (cloud(a.m) - cloud(b.m))
        || (size(a.m) - size(b.m)) || (a.i - b.i))
        .slice(0, limit).map(({ m }) => ({ name: m.name, use: tick(m), workers: 1,
            context: Math.min(Number(m.loaded_context || m.context_max || 32768), 32768) || 32768, note: '',
            thinks: m.thinks, thinking: m.thinking || '', fresh: true }));
}

export function subagentPool(status) {
    const systems = (status?.systems || []).filter(s => s.enabled !== false && (s.jobs || []).includes('subagents'));
    const free = systems.reduce((sum, s) => sum + (s.health?.state === 'offline' ? 0 : Number(s.free) || 0), 0);
    return { systems: systems.length, free };
}
/** The Pips choices with the Router on: [value, label] for any Pip system and each Pip system's models. */
export function pipChoices(status) {
    const out = [['router', 'Any Pip system']];
    for (const s of status?.systems || []) {
        if (s.enabled === false || !(s.jobs || []).includes('pips')) continue;
        for (const m of s.models || []) if (m.use !== false) out.push([`router:${s.id}/${m.name}`, `${s.name} · ${m.name}`]);
    }
    return out;
}

/** A Router model's Thinking: its own choice, "Same as the helper" (empty), or "doesn't think" for a model its server
 *  says can't (the probe's `thinks`), as the row shows it. */
export const THINKING = [['', 'Same as the helper'], ['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
export function thinkingWords(m) {
    if (m?.thinks === false) return 'doesn\'t think';
    if (m?.thinks !== true) return 'Not known yet';
    return (THINKING.find(([v]) => v === (m.thinking || '')) || THINKING[0])[1];
}

export function createRouter({ send, esc, switchHTML, onPaint, ui }) {
    const S = { capable: false, pipsDefault: false, thinking: false, status: null, asked: false, unavailable: '', seq: 0,
        waiting: new Map(), busy: new Set(), notes: new Map(), edits: new Map(), adding: null, find: null,
        suggestions: new Map(), probes: new Map(), removing: '', switching: false, error: '' };
    const page = () => document.getElementById('models-router');

    // ---- talking to DGC: one command, one answer (routerReply), by token ----
    function command(cmd, what) {
        const token = `router-${++S.seq}`;
        return new Promise(resolve => {
            S.waiting.set(token, resolve);
            send({ type: 'routerCommand', token, command: cmd, ...(what ? { what } : {}) });
        });
    }
    function receive(msg) {
        if (msg.type === 'routerStatus') {
            if (msg.status && typeof msg.status === 'object') S.status = msg.status;
            if (msg.unavailable) S.unavailable = String(msg.unavailable);
            paint();
            return true;
        }
        if (msg.type === 'routerReply') {
            if (msg.status && typeof msg.status === 'object') S.status = msg.status;
            const done = S.waiting.get(msg.token);
            S.waiting.delete(msg.token);
            if (typeof done === 'function') done(msg);
            paint();
            return true;
        }
        return false;
    }
    function setCapability(config) {
        S.capable = config?.router_capable === true;
        S.pipsDefault = config?.router_pips_default === true;
        // Each model's Thinking (ready.capabilities.router.thinking; the extension adds it): an older CLI has none.
        S.thinking = config?.router_thinking === true;
        if (S.capable && !S.asked) { S.asked = true; void command({ type: 'router_status' }); }
    }
    const on = () => S.status?.enabled === true;
    const systems = () => S.status?.systems || [];
    const system = id => systems().find(s => s.id === id);
    const note = (key, text, error = false) => { if (text) S.notes.set(key, { text: String(text), error }); else S.notes.delete(key); };

    // ---- the page's own blocks ----
    function summary() {
        const pool = subagentPool(S.status);
        return `Chosen by DGC Router · ${pool.systems} system${pool.systems === 1 ? '' : 's'} · ${pool.free} worker${pool.free === 1 ? '' : 's'} free`;
    }
    function routerBlock() {
        if (!S.capable) {
            return '<section class="group" id="models-router" data-block="router"><h3>DGC Router</h3><div class="rows"><div class="row-line is-off"><span class="words"><span class="name">Use my other computers</span><span class="hint">Update the DGC CLI to use DGC Router.</span></span></div></div></section>';
        }
        const enabled = on();
        const more = 'Spread sub-agents and Pips across the computers on your network that run models. Each helper\'s model requests go to that computer and carry the same project text the main model sees; its tools still run here. Add only computers you trust. An http:// address on another network isn\'t encrypted.';
        const row = '<div class="field router-switch"><span class="words"><span class="name-line"><label class="name" for="router-on">Use my other computers</label>'
            + ui.infoButton('router-on', 'DGC Router') + '</span>'
            + '<span class="hint">Sub-agents and Pips on other computers.</span>'
            + ui.detail('router-on', esc(more)) + '</span>'
            + switchHTML(enabled, 'Use my other computers', 'id="router-on" data-router-switch', S.switching || !S.status) + '</div>';
        const failed = S.notes.get('router') ? `<p class="router-note${S.notes.get('router').error ? ' error' : ''}" role="status">${esc(S.notes.get('router').text)}</p>` : '';
        return `<section class="group" id="models-router" data-block="router"><h3>DGC Router</h3><div class="rows">${row}</div>${failed}`
            + (enabled ? systemsBlock() : '') + '</section>';
    }
    function systemsBlock() {
        const list = systems();
        const busyWait = S.status?.when_busy !== 'default';
        const findOpen = S.find;
        const head = '<div class="router-head"><h4>Systems</h4><span class="actions">'
            + '<button type="button" class="secondary" data-router-add>+ Add system</button>'
            + `<button type="button" class="secondary" data-router-find${findOpen?.state === 'looking' ? ' disabled' : ''}>Look on my network</button></span></div>`;
        const cards = (S.adding ? addCard() : '') + (findOpen ? findCard() : '')
            + (list.length ? list.map(card).join('') : (S.adding ? '' : '<p class="router-empty">No systems yet. Add a computer that runs Ollama, llama.cpp, vLLM, LM Studio or another OpenAI-compatible server.</p>'));
        const busy = '<div class="router-busy" role="radiogroup" aria-label="When every system is busy"><span class="router-busy-label">When all are busy:</span>'
            + `<label><input type="radio" name="router-when-busy" value="wait"${busyWait ? ' checked' : ''}> wait for a free worker</label>`
            + `<label><input type="radio" name="router-when-busy" value="default"${busyWait ? '' : ' checked'}> use the sub-agent model above</label></div>`;
        return `<div class="router-systems" aria-label="Systems">${head}<div class="router-list">${cards}</div>${busy}<p class="router-saved">Changes here are saved as you make them.</p></div>`;
    }
    function dot(s) {
        const state = s.enabled === false ? 'off' : s.health?.state || 'unknown';
        const words = state === 'online' ? 'Online' : state === 'offline' ? 'Offline' : state === 'off' ? 'Not used' : 'Not checked yet';
        return `<span class="router-dot ${state}" role="img" aria-label="${words}" title="${words}"></span>`;
    }
    function freeWords(s) {
        if (s.enabled === false) return 'not used';
        if (s.health?.state === 'offline') return `offline since ${clock(s.health.offline_since || s.health.checked)}`;
        return `${s.free} of ${s.workers} worker${s.workers === 1 ? '' : 's'} free`;
    }
    function card(s) {
        const edit = S.edits.get(s.id);
        const busyKey = S.busy;
        const total = totalContext(s), room = roomCheck(s, total);
        const used = (s.models || []).filter(m => m.use !== false);
        const live = s.enabled !== false && s.health?.state !== 'offline';
        const tested = used.filter(m => testWords(m));
        const jobs = (s.jobs || []).map(j => JOB_NAMES[j] || j).join(' · ') || 'none';
        const hardware = hardwareWords(s.hardware);
        const leases = (s.leases || []).filter(l => l.label || l.model);
        const n = S.notes.get(s.id);
        const probe = S.probes.get(s.id), suggestion = S.suggestions.get(s.id);
        const head = `<div class="router-card-head">${dot(s)}<span class="router-name">${esc(s.name)}</span>`
            + `<span class="router-where">${esc(SERVER_NAMES[s.server] || s.server)} · ${esc(shortAddress(s.base_url))}</span>`
            + `<span class="router-free" data-router-free="${esc(s.id)}">${esc(freeWords(s))}</span></div>`;
        if (edit) return `<article class="router-card editing" data-router-system="${esc(s.id)}">${head}${editForm(s, edit)}</article>`;
        // The card lists the models it uses; the rest are under Edit, counted here.
        const unused = (s.models || []).length - used.length;
        const think = S.thinking ? ' thinking' : '';
        const models = used.length ? '<div class="router-models" role="table" aria-label="Models on ' + esc(s.name) + '">'
            + `<div class="router-model head${think}" role="row"><span role="columnheader">Model</span><span role="columnheader">Use</span><span role="columnheader">Workers</span><span role="columnheader">Context each</span>${S.thinking ? '<span role="columnheader">Thinking</span>' : ''}<span role="columnheader">Note</span></div>`
            + used.map(m => `<div class="router-model${m.use === false ? ' unused' : ''}${think}" role="row"><span role="cell" class="router-model-name">${esc(m.name)}${sizeWords(m) ? ` <small>(${esc(sizeWords(m))})</small>` : ''}${m.subagents ? `<small class="router-warn">${esc(m.subagents)}</small>` : ''}</span>`
                + `<span role="cell" data-label="Use">${m.use === false ? '—' : '✓'}</span><span role="cell" data-label="Workers">${live && m.use !== false ? `${esc(m.free ?? m.workers)}/${esc(m.workers)} free` : esc(m.workers)}</span>`
                + `<span role="cell" data-label="Context each">${esc(tokensShort(m.context))}</span>`
                + (S.thinking ? `<span role="cell" data-label="Thinking"${m.thinks === true ? '' : ' class="muted"'}>${esc(thinkingWords(m))}</span>` : '')
                + `<span role="cell"${m.note ? ' data-label="Note"' : ''}>${esc(m.note || '')}</span></div>`).join('')
            + '</div>' + (unused > 0 ? `<p class="router-line muted">${unused} more model${unused === 1 ? '' : 's'} not used (Edit to choose).</p>` : '')
            : `<p class="router-line muted">${s.has_key === false && /key/i.test(s.discovery_error || '') ? 'It wants a key: choose Edit to add one.' : 'No models chosen yet: choose Edit to pick some.'}</p>`;
        const totals = total ? `<p class="router-line">${s.one_model_at_a_time ? '<span class="router-one">One model at a time</span> · ' : ''}${esc(totalLine(total))}${room ? ` · <span class="${room.ok ? 'router-ok' : 'router-bad'}">${esc(room.text)}</span>` : ''}</p>`
            : (s.one_model_at_a_time ? '<p class="router-line"><span class="router-one">One model at a time</span></p>' : '');
        const lastAt = Math.max(0, ...tested.map(m => Number(m.speed_at) || 0));
        const lastTest = tested.length ? `<p class="router-line">Last test${lastAt ? ` (<span data-router-ago="${esc(lastAt)}">${esc(ago(lastAt))}</span>)` : ''}: ${tested.map(m => `${tested.length > 1 ? esc(m.name) + ' ' : ''}${esc(testWords(m))}`).join('; ')}</p>` : '<p class="router-line muted">Not tested yet.</p>';
        const working = leases.length ? `<p class="router-line router-leases" aria-live="polite">Working: ${leases.map(l => `${esc(l.model || '')} for ${esc(l.label || 'a helper')}`).join(' · ')}</p>` : '';
        const removing = S.removing === s.id ? `<div class="router-confirm" role="group" aria-label="Remove ${esc(s.name)}"><span>Remove ${esc(s.name)}? Its saved key goes too.</span><button type="button" class="secondary danger" data-router-remove-yes="${esc(s.id)}">Remove</button><button type="button" class="secondary" data-router-remove-no>Keep it</button></div>` : '';
        // While its removal is asked, the question holds the only Remove (and Keep it): no second Remove beside it.
        const buttons = S.removing === s.id ? '' : `<div class="actions router-buttons"><button type="button" class="secondary" data-router-test="${esc(s.id)}"${busyKey.has('test:' + s.id) ? ' disabled' : ''}>${busyKey.has('test:' + s.id) ? 'Testing…' : 'Test'}</button>`
            + `<button type="button" class="secondary" data-router-suggest="${esc(s.id)}"${busyKey.has('suggest:' + s.id) ? ' disabled' : ''}>${busyKey.has('suggest:' + s.id) ? 'Working it out…' : 'Suggest'}</button>`
            + `<button type="button" class="secondary" data-router-edit="${esc(s.id)}">Edit</button><button type="button" class="secondary" data-router-remove="${esc(s.id)}">Remove</button></div>`;
        return `<article class="router-card" data-router-system="${esc(s.id)}">${head}<p class="router-line">Jobs: ${esc(jobs)}</p>${models}${totals}${lastTest}`
            + (hardware ? `<p class="router-line">Hardware: ${esc(hardware)}</p>` : '') + working
            + (s.warning ? `<p class="router-line muted">${esc(s.warning)}</p>` : '')
            + (probe ? probeBlock(probe) : '') + (suggestion ? suggestBlock(s, suggestion) : '')
            + (n ? `<p class="router-note${n.error ? ' error' : ''}" role="status">${esc(n.text)}</p>` : '') + removing + buttons + '</article>';
    }
    function hardwareWords(h) {
        if (!h) return '';
        if (h.source === 'node' && !h.has_token) return 'a dgc node that needs its pairing token (Edit)';
        if (h.line) return h.line + (h.error ? ` (the last read failed: ${h.error})` : '');
        if (h.error) return `couldn't read it: ${h.error}`;
        return 'not read yet';
    }
    function probeBlock(probe) {
        if (probe.state === 'testing') return '<p class="router-line" role="status">Testing… this uses a few seconds of that computer\'s model.</p>';
        const result = probe.result || {};
        const lines = [];
        if (result.models_error) lines.push(`Couldn't list its models: ${result.models_error}`);
        const unloaded = [];
        for (const [name, checks] of Object.entries(result.results || {})) {
            if (checks.not_loaded) { unloaded.push(name); lines.push(`${name}: ${checks.error}. Not tested.`); continue; }
            if (checks.error) { lines.push(`${name}: ${checks.error}`); continue; }
            const bits = [];
            if (checks.speed) bits.push(checks.speed.ok ? `${checks.speed.tokens_per_s} tok/s, first token in ${checks.speed.ttft_ms} ms` : `speed test failed: ${checks.speed.error || ''}`);
            if (checks.parallel) bits.push(checks.parallel.ok ? `runs ${checks.parallel.runs} at once` : `parallel test failed: ${checks.parallel.error || ''}`);
            if (checks.tools) bits.push(checks.tools.ok ? 'tool calls ✓' : 'tool calls ✗ (kept away from sub-agents)');
            lines.push(`${name}: ${bits.join(' · ')}`);
        }
        if (!lines.length) lines.push('Nothing to test: choose a model first.');
        // Testing a model that isn't loaded loads it on that computer: only when the person asks, by name.
        const load = unloaded.map(name => `<button type="button" class="secondary" data-router-test-model="${esc(name)}">Test ${esc(name)} (loads it)</button>`).join('');
        return `<div class="router-result" role="status"><b>Test</b><ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>${load ? `<div class="actions">${load}</div>` : ''}</div>`;
    }
    function suggestBlock(s, sg) {
        if (sg.state === 'working') return '<p class="router-line" role="status">Working it out…</p>';
        const value = sg.suggestion || {};
        const lines = (value.models || []).map(m => m.line).filter(Boolean);
        const notes = (value.notes || []).filter(Boolean);
        const apply = value.applicable ? `<button type="button" class="save" data-router-apply="${esc(s.id)}"${S.busy.has('apply:' + s.id) ? ' disabled' : ''}>Apply</button>` : '';
        return `<div class="router-result router-suggest" role="status"><b>Suggest</b><ul>${(lines.length ? lines : [value.line || 'DGC can\'t back a number yet: Test it first, or set its memory under Edit.']).map(l => `<li>${esc(l)}</li>`).join('')}</ul>`
            + (notes.length ? `<p class="muted">${notes.map(esc).join(' ')}</p>` : '')
            + `<div class="actions">${apply}<button type="button" class="secondary" data-router-suggest-close="${esc(s.id)}">Close</button></div></div>`;
    }

    // ---- + Add system ----
    function addCard() {
        const a = S.adding;
        const looking = a.state === 'looking';
        return '<article class="router-card adding" data-router-adding><div class="router-card-head"><span class="router-name">Add a system</span></div>'
            + '<div class="router-form">'
            + `<label class="router-field"><span>Address</span><input id="router-add-address" type="text" value="${esc(a.address)}" placeholder="gpu-box.local or 10.0.0.5:11434" autocomplete="off" spellcheck="false"${looking ? ' disabled' : ''}></label>`
            + `<label class="router-field"><span>Name <small>(optional)</small></span><input id="router-add-name" type="text" value="${esc(a.name)}" placeholder="GPU box" autocomplete="off" spellcheck="false"${looking ? ' disabled' : ''}></label>`
            + '<p class="muted">DGC finds the server on that computer and lists its models. Nothing is installed there.</p>'
            + (a.error ? `<p class="router-note error" role="alert">${esc(a.error)}</p>` : '')
            + `<div class="actions"><button type="button" class="save" data-router-add-look${looking ? ' disabled' : ''}>${looking ? 'Looking…' : 'Find its models'}</button><button type="button" class="secondary" data-router-add-cancel>Cancel</button></div>`
            + '</div></article>';
    }
    function startAdd(address = '', name = '') {
        S.adding = { address, name, state: '', error: '' };
        paint();
        // From Look on my network the address is filled in: name it, then Find its models.
        queueMicrotask(() => document.getElementById(address ? 'router-add-name' : 'router-add-address')?.focus());
    }
    async function look() {
        const a = S.adding;
        if (!a) return;
        a.address = (document.getElementById('router-add-address')?.value ?? a.address).trim();
        a.name = (document.getElementById('router-add-name')?.value ?? a.name).trim();
        if (!a.address) { a.error = 'Type its address first.'; paint(); return; }
        a.state = 'looking'; a.error = ''; paint();
        const before = new Set(systems().map(s => s.id));
        // Add with no jobs atomically: a new system must not receive work while this form is still being filled in.
        const reply = await command({ type: 'router_update', action: 'add_system', base_url: a.address, jobs: [], ...(a.name ? { name: a.name } : {}) });
        if (!reply.ok) { a.state = ''; a.error = reply.error || 'DGC couldn\'t add it.'; paint(); return; }
        const added = systems().find(s => !before.has(s.id));
        if (!added) { a.state = ''; a.error = 'DGC added nothing.'; paint(); return; }
        // Not used until Save: a half set-up system never gets a helper.
        await command({ type: 'router_update', action: 'disable_system', system: added.id });
        S.adding = null;
        const wantsKey = /wants a key/i.test(reply.change || '');
        const draft = draftFor(system(added.id) || added, { added: true, wantsKey });
        if (!draft.models.length && !wantsKey) {
            // Nothing was loaded there: DGC chose none. Its models are offered unticked; the person ticks what to use.
            draft.models = offeredRows((system(added.id) || added).available, (system(added.id) || added).server);
            draft.choose = draft.models.length > 0 && !draft.models.some(m => m.use);
        }
        S.edits.set(added.id, draft);
        paint();
        queueMicrotask(() => document.querySelector(`[data-router-system="${CSS.escape(added.id)}"] ${wantsKey ? '[data-edit="key"]' : 'input'}`)?.focus());
    }

    // ---- Look on my network ----
    function findCard() {
        const f = S.find;
        if (f.state === 'ask') {
            return '<article class="router-card finding" data-router-finding><p>Look for model servers on this computer\'s network? DGC checks the usual ports '
                + `(${ROUTER_PORTS}) on your local network only, once, and adds nothing until you choose.</p>`
                + '<div class="actions"><button type="button" class="save" data-router-find-yes>Look</button><button type="button" class="secondary" data-router-find-no>Cancel</button></div></article>';
        }
        if (f.state === 'looking') return '<article class="router-card finding" data-router-finding><p role="status">Looking on your network… this takes a few seconds.</p></article>';
        if (f.error) return `<article class="router-card finding" data-router-finding><p class="router-note error" role="alert">${esc(f.error)}</p><div class="actions"><button type="button" class="secondary" data-router-find-no>Close</button></div></article>`;
        const found = f.found?.found || [];
        const known = new Map(systems().map(s => [String(s.base_url).replace(/\/+$/, ''), s]));
        const rows = found.map(item => {
            const added = known.get(String(item.base_url).replace(/\/+$/, ''));
            return `<li><span><b>${esc(SERVER_NAMES[item.server] || item.server)}</b>${item.version ? ` ${esc(item.version)}` : ''} · ${esc(shortAddress(item.base_url))}${item.note ? ` <small>(${esc(item.note)})</small>` : ''}</span>`
                + (added ? `<span class="muted">Added as ${esc(added.name)}</span>` : item.server === 'comfyui' ? '<span class="muted">Image generation: not a system</span>'
                    : `<button type="button" class="secondary" data-router-found="${esc(item.base_url)}">Add</button>`) + '</li>';
        }).join('');
        return `<article class="router-card finding" data-router-finding><p>${found.length ? `Found on ${esc(f.found?.network || 'your network')}:` : `No model server answered on ${esc(f.found?.network || 'your network')}.`}</p>`
            + (rows ? `<ul class="router-found">${rows}</ul>` : '') + '<div class="actions"><button type="button" class="secondary" data-router-find-no>Close</button></div></article>';
    }

    // ---- Edit (and the rest of Add) ----
    /** A model row's Thinking: a choice for a model that can think, else "doesn't think" (nothing to choose). */
    function thinkingCell(m, i, busy) {
        if (m.thinks !== true) return `<span role="cell" data-label="Thinking" class="muted${m.thinks === false ? ' router-no-think' : ''}">${esc(thinkingWords(m))}</span>`;
        return `<label role="cell" data-label="Thinking"><select data-edit="thinking" data-i="${i}" aria-label="Thinking for ${esc(m.name)}"${busy ? ' disabled' : ''}>`
            + THINKING.map(([v, label]) => `<option value="${v}"${(m.thinking || '') === v ? ' selected' : ''}>${label}</option>`).join('') + '</select></label>';
    }
    function draftFor(s, extra = {}) {
        return { added: false, wantsKey: false, name: s.name, base_url: s.base_url, jobs: [...(s.jobs || [])], workers: s.workers,
            one: !!s.one_model_at_a_time, enabled: extra.added ? true : s.enabled !== false, memory: s.memory_gb ?? '',
            models: (s.models || []).map(m => ({ name: m.name, use: m.use !== false, workers: m.workers, context: m.context, note: m.note || '',
                thinking: m.thinking || '', thinks: m.thinks, fresh: false })),
            key: '', hwUrl: s.hardware?.url || '', hwToken: '', state: '', ...extra };
    }
    function editForm(s, d) {
        const busy = d.state === 'saving' || d.state === 'testing' || d.state === 'key';
        const offered = (s.available || []).filter(m => m.kind !== 'embedding' && !d.models.some(x => x.name.toLowerCase() === m.name.toLowerCase()));
        const modelRows = d.models.map((m, i) => {
            const facts = (s.available || []).find(x => x.name === m.name) || (s.models || []).find(x => x.name === m.name) || {};
            const max = Number(facts.context_max) || 0;
            return `<div class="router-model edit${S.thinking ? ' thinking' : ''}" role="row" data-model-row="${i}" data-model-name="${esc(m.name)}"><label class="router-use" role="cell"><input type="checkbox" data-edit="use" data-i="${i}"${m.use ? ' checked' : ''}${busy ? ' disabled' : ''}> <span>${esc(m.name)}${sizeWords(facts) ? ` <small>(${esc(sizeWords(facts))})</small>` : ''}${facts.tools === false ? ' <small class="router-warn">no tool calls</small>' : ''}</span></label>`
                + `<label role="cell" data-label="Workers"><input type="number" min="1" max="64" step="1" aria-label="Workers for ${esc(m.name)}" data-edit="workers" data-i="${i}" value="${esc(m.workers)}"${busy ? ' disabled' : ''}></label>`
                // A box you type in or pick from (src/contextCombo.js): 4K … 256K up to the model's own maximum, or any size.
                + `<span role="cell" data-label="Context each">${contextComboHTML({ id: `router-ctx-${s.id}-${i}`, value: m.context, max,
                    label: `Context for ${m.name}`, attrs: `data-edit="context" data-i="${i}"`, disabled: busy })}</span>`
                + (S.thinking ? thinkingCell(m, i, busy) : '')
                + `<label role="cell" data-label="Note"><input type="text" maxlength="120" aria-label="Note for ${esc(m.name)}" data-edit="note" data-i="${i}" value="${esc(m.note)}" placeholder="Note"${busy ? ' disabled' : ''}></label></div>`;
        }).join('');
        const keyRow = `<label class="router-field${d.wantsKey ? ' wants' : ''}"><span>Key${d.wantsKey ? ' <small>(this server wants one)</small>' : ' <small>(only if it needs one)</small>'}</span>`
            + `<span class="router-inline"><input type="password" data-edit="key" value="${esc(d.key)}" placeholder="${s.has_key ? 'Saved' : 'Paste its key'}" autocomplete="off" spellcheck="false"${busy ? ' disabled' : ''}>`
            + (d.wantsKey ? `<button type="button" class="secondary" data-router-key="${esc(s.id)}"${busy ? ' disabled' : ''}>${d.state === 'key' ? 'Looking…' : 'Use the key'}</button>` : '') + '</span></label>';
        const how = '<details class="more router-how"><summary>How to set this up</summary><p>Either point DGC at an exporter you already run on that computer (Prometheus node_exporter on :9100, NVIDIA DCGM on :9400, Glances on :61208, Netdata on :19999), or run DGC\'s own read-only stats service there:</p>'
            + '<pre><code>dgc node install-service</code></pre><p>It prints a pairing token once (on a Mac you reach only over SSH, add <code>--system</code>). Paste its address (port 8577) and that token here. It has no shell and reads no file of yours.</p></details>';
        return '<div class="router-form">'
            + (d.added ? `<p class="router-line">Found ${esc(SERVER_NAMES[s.server] || s.server)} at ${esc(shortAddress(s.base_url))}. Choose its models and jobs, then Test and Save.</p>` : '')
            + (d.choose && !d.models.some(m => m.use) ? `<p class="router-line router-choose" role="note">Nothing is loaded on ${esc(s.name)} now, so none is ticked. Tick the ones to use: using one loads it there.</p>` : '')
            + (d.wantsKey ? keyRow : '')
            + `<div class="router-grid"><label class="router-field"><span>Name</span><input type="text" data-edit="name" value="${esc(d.name)}" maxlength="64"${busy ? ' disabled' : ''}></label>`
            + `<label class="router-field"><span>Address</span><input type="text" data-edit="base_url" value="${esc(d.base_url)}" autocomplete="off" spellcheck="false"${busy ? ' disabled' : ''}></label></div>`
            + `<fieldset class="router-jobs"><legend>Jobs</legend>${Object.entries(JOB_NAMES).map(([id, label]) => `<label><input type="checkbox" data-edit="job" value="${id}"${d.jobs.includes(id) ? ' checked' : ''}${busy ? ' disabled' : ''}> ${label}</label>`).join('')}</fieldset>`
            + `<div class="router-models" role="table" aria-label="Models on ${esc(s.name)}"><div class="router-model head edit${S.thinking ? ' thinking' : ''}" role="row"><span role="columnheader">Use · model</span><span role="columnheader">Workers</span><span role="columnheader">Context each</span>${S.thinking ? '<span role="columnheader">Thinking</span>' : ''}<span role="columnheader">Note</span></div>${modelRows || '<p class="muted router-none">No models yet.</p>'}</div>`
            + (offered.length ? `<div class="router-inline router-add-model"><select id="router-offer-${esc(s.id)}" aria-label="Another model it serves" data-edit="offer"${busy ? ' disabled' : ''}><option value="">Another model it serves…</option>${offered.map(m => `<option value="${esc(m.name)}">${esc(m.name)}${sizeWords(m) ? ` (${esc(sizeWords(m))})` : ''}</option>`).join('')}</select></div>` : '')
            + `<div class="router-grid"><label class="router-field"><span>Workers <small>(all models together)</small></span><input type="number" min="1" max="64" data-edit="workers-total" value="${esc(d.workers)}"${busy ? ' disabled' : ''}></label>`
            + `<label class="router-field"><span>Memory, GB <small>(for Suggest, if known)</small></span><input type="number" min="1" max="4096" step="any" data-edit="memory" value="${esc(d.memory)}"${busy ? ' disabled' : ''}></label></div>`
            + `<label class="router-check"><input type="checkbox" data-edit="one"${d.one ? ' checked' : ''}${busy ? ' disabled' : ''}> One model at a time <small>(a computer that holds one big model in its memory)</small></label>`
            + `<label class="router-check"><input type="checkbox" data-edit="enabled"${d.enabled ? ' checked' : ''}${busy ? ' disabled' : ''}> Use this system</label>`
            + (d.wantsKey ? '' : keyRow)
            + '<fieldset class="router-hardware"><legend>Hardware <small>(optional)</small></legend>'
            + `<div class="router-grid"><label class="router-field"><span>Exporter or dgc node address</span><input type="text" data-edit="hw-url" value="${esc(d.hwUrl)}" placeholder="gpu-box.local:8577" autocomplete="off" spellcheck="false"${busy ? ' disabled' : ''}></label>`
            + `<label class="router-field"><span>Pairing token <small>(dgc node only)</small></span><input type="password" data-edit="hw-token" value="${esc(d.hwToken)}" placeholder="${s.hardware?.has_token ? 'Saved' : ''}" autocomplete="off" spellcheck="false"${busy ? ' disabled' : ''}></label></div>${how}</fieldset>`
            + (S.probes.get(s.id) ? probeBlock(S.probes.get(s.id)) : '')
            + (d.error ? `<p class="router-note error" role="alert">${esc(d.error)}</p>` : '') + (d.done ? `<p class="router-note" role="status">${esc(d.done)}</p>` : '')
            + `<div class="actions"><button type="button" class="secondary" data-router-edit-test="${esc(s.id)}"${busy ? ' disabled' : ''}>${d.state === 'testing' ? 'Testing…' : 'Test'}</button>`
            + `<button type="button" class="save" data-router-edit-save="${esc(s.id)}"${busy ? ' disabled' : ''}>${d.state === 'saving' ? 'Saving…' : 'Save'}</button>`
            + `<button type="button" class="secondary" data-router-edit-cancel="${esc(s.id)}"${busy ? ' disabled' : ''}>Cancel</button></div></div>`;
    }
    /** What was typed into an open form, kept in its draft so a live redraw never loses it. */
    function readForm(id) {
        const d = S.edits.get(id), root = document.querySelector(`[data-router-system="${CSS.escape(id)}"] .router-form`);
        if (!d || !root) return d;                          // the form isn't drawn yet: its draft is all there is
        const val = sel => root.querySelector(sel);
        d.name = val('[data-edit="name"]')?.value ?? d.name;
        d.base_url = val('[data-edit="base_url"]')?.value ?? d.base_url;
        d.jobs = [...root.querySelectorAll('[data-edit="job"]')].filter(b => b.checked).map(b => b.value);
        d.workers = val('[data-edit="workers-total"]')?.value ?? d.workers;
        d.memory = val('[data-edit="memory"]')?.value ?? d.memory;
        d.one = val('[data-edit="one"]')?.checked ?? d.one;
        d.enabled = val('[data-edit="enabled"]')?.checked ?? d.enabled;
        d.key = val('[data-edit="key"]')?.value ?? d.key;
        d.hwUrl = val('[data-edit="hw-url"]')?.value ?? d.hwUrl;
        d.hwToken = val('[data-edit="hw-token"]')?.value ?? d.hwToken;
        root.querySelectorAll('[data-model-row]').forEach(row => {
            // By name: a save can redraw the form with fewer rows (the unticked ones aren't saved).
            const m = d.models.find(x => x.name === row.dataset.modelName);
            if (!m) return;
            m.use = row.querySelector('[data-edit="use"]')?.checked ?? m.use;
            m.workers = row.querySelector('[data-edit="workers"]')?.value ?? m.workers;
            m.context = row.querySelector('[data-edit="context"]')?.value ?? m.context;
            m.note = row.querySelector('[data-edit="note"]')?.value ?? m.note;
            m.thinking = row.querySelector('[data-edit="thinking"]')?.value ?? m.thinking;
        });
        return d;
    }
    const int = (v, fallback) => { const n = Number(String(v).trim()); return Number.isInteger(n) && n > 0 ? n : fallback; };
    /** The changes an open form makes, as router_* commands, in order. Throws a plain reason for a bad value. */
    function changes(s, d) {
        const out = [];
        const name = String(d.name || '').trim(), base = String(d.base_url || '').trim();
        if (!name) throw new Error('Give it a name.');
        const workers = int(d.workers, 0);
        if (!workers || workers > 64) throw new Error('Workers takes 1 to 64.');
        const memoryText = String(d.memory ?? '').trim(), memory = memoryText === '' ? null : Number(memoryText);
        if (memory !== null && !(memory > 0 && memory <= 4096)) throw new Error('Memory takes a number of GB, or leave it blank.');
        const edit = {};
        if (name !== s.name) edit.name = name;
        if (base && base !== s.base_url) edit.base_url = base;
        if (workers !== s.workers) edit.workers = workers;
        if (d.one !== !!s.one_model_at_a_time) edit.one_model_at_a_time = d.one;
        if (memory !== null && memory !== Number(s.memory_gb || 0)) edit.memory_gb = memory;
        const jobs = Object.keys(JOB_NAMES).filter(j => d.jobs.includes(j));
        if (jobs.join() !== Object.keys(JOB_NAMES).filter(j => (s.jobs || []).includes(j)).join()) out.push({ type: 'router_update', action: 'set_jobs', system: s.id, jobs });
        if (Object.keys(edit).length) out.unshift({ type: 'router_update', action: 'edit_system', system: s.id, ...edit });
        for (const m of d.models) {
            const was = (s.models || []).find(x => x.name === m.name);
            const mw = int(m.workers, 0), typed = parseContext(m.context);
            if (!mw || mw > 64) throw new Error(`Workers for ${m.name} takes 1 to 64.`);
            if (typeof typed !== 'number' || typed < 2048) throw new Error(`Context for ${m.name} takes 2K (2,048 tokens) or more, like 16K or 24576.`);
            if (typed > 16777216) throw new Error(`Context for ${m.name} takes up to 16,384K.`);
            // Above what the model handles is allowed: DGC uses the model's own maximum, as the box said.
            const most = Number(((s.available || []).find(x => x.name === m.name) || (s.models || []).find(x => x.name === m.name) || {}).context_max) || 0;
            const ctx = most && typed > most ? most : typed;
            if (!was && !m.use) continue;                        // offered, then unticked: nothing to add
            const change = {};
            if (!was || (was.use !== false) !== m.use) change.use = m.use;
            if (!was || was.workers !== mw) change.workers = mw;
            if (!was || was.context !== ctx) change.context = ctx;
            if (!was ? !!m.note.trim() : (was.note || '') !== m.note.trim()) change.note = m.note.trim();
            if (Object.keys(change).length) out.push({ type: 'router_update', action: 'set_model', system: s.id, model: m.name, ...change });
            // How hard a helper on it thinks: its own command (router_thinking), from a CLI that takes it.
            if (S.thinking && m.use && (was?.thinking || '') !== (m.thinking || '') && THINKING.some(([v]) => v === (m.thinking || ''))) {
                out.push({ type: 'router_thinking', system: s.id, model: m.name, thinking: m.thinking || '' });
            }
        }
        if (d.key.trim()) out.push({ type: 'router_update', action: 'set_key', system: s.id, key: d.key.trim() });
        const hwUrl = String(d.hwUrl || '').trim(), hwWas = String(s.hardware?.url || '');
        if (hwUrl !== hwWas || d.hwToken.trim()) {
            out.push({ type: 'router_hardware', system: s.id, ...(hwUrl !== hwWas ? { url: hwUrl || 'off' } : {}), ...(d.hwToken.trim() ? { token: d.hwToken.trim() } : {}) });
        }
        if (d.enabled !== (s.enabled !== false)) out.push({ type: 'router_update', action: d.enabled ? 'enable_system' : 'disable_system', system: s.id });
        return out;
    }
    async function run(list, d) {
        for (const cmd of list) {
            const reply = await command(cmd);
            if (!reply.ok) { d.error = reply.error || 'DGC didn\'t make that change.'; return false; }
        }
        return true;
    }
    async function save(id, { close = true } = {}) {
        const s = system(id), d = readForm(id);
        if (!s || !d) return false;
        d.error = ''; d.done = '';
        let list;
        try { list = changes(s, d); } catch (error) { d.error = error.message; paint(); return false; }
        d.state = 'saving'; paint();
        const ok = await run(list, d);
        d.state = '';
        if (ok) {
            d.key = ''; d.hwToken = '';
            if (close) { S.edits.delete(id); S.probes.delete(id); }     // the card's Last test line says it now
            else {
                const fresh = system(id);
                if (fresh) {
                    // Kept open (Test): what was saved, and the offered rows still unticked, to tick later.
                    const next = { ...draftFor(fresh), added: d.added, done: '', choose: d.choose };
                    next.models.push(...d.models.filter(m => m.fresh && !m.use && !next.models.some(x => x.name === m.name)));
                    S.edits.set(id, next);
                }
            }
            if (close) note(id, list.length ? 'Saved.' : '');
        }
        paint();
        return ok;
    }
    async function useKey(id) {
        const s = system(id), d = readForm(id);
        if (!s || !d || !d.key.trim()) { if (d) { d.error = 'Paste its key first.'; paint(); } return; }
        d.state = 'key'; d.error = ''; paint();
        const saved = await command({ type: 'router_update', action: 'set_key', system: id, key: d.key.trim() });
        if (!saved.ok) { d.state = ''; d.error = saved.error || 'DGC didn\'t keep the key.'; paint(); return; }
        d.key = '';
        const read = await command({ type: 'router_probe', system: id, checks: ['models'] }, 'probe');
        d.state = '';
        if (!read.ok || read.probe?.models_error) { d.error = read.error || `With that key: ${read.probe?.models_error}`; paint(); return; }
        d.wantsKey = false;
        const fresh = system(id);
        // Offer what it serves now that it can be read, as Add does: what it has loaded ticked, the rest to tick.
        if (fresh && !d.models.length) {
            d.models = offeredRows(fresh.available, fresh.server);
            d.choose = d.models.length > 0 && !d.models.some(m => m.use);
        }
        d.done = `Key saved. It serves ${read.probe?.models ?? 0} model${read.probe?.models === 1 ? '' : 's'}.`;
        paint();
    }
    async function test(id, fromForm, model = '') {
        if (fromForm) {
            const d = S.edits.get(id);
            if (!(await save(id, { close: false }))) return;
            if (d) S.edits.get(id).state = 'testing';
        }
        S.busy.add('test:' + id);
        S.probes.set(id, { state: 'testing' });
        paint();
        const reply = await command({ type: 'router_probe', system: id, ...(model ? { model } : {}) }, 'probe');
        S.busy.delete('test:' + id);
        const d = S.edits.get(id);
        if (d) d.state = '';
        if (reply.ok) S.probes.set(id, { result: reply.probe || {} });
        else { S.probes.delete(id); note(id, reply.error || 'The test didn\'t run.', true); }
        if (reply.ok && reply.probe?.suggest && !fromForm) S.suggestions.set(id, { suggestion: reply.probe.suggest });
        paint();
    }
    async function suggest(id) {
        S.busy.add('suggest:' + id);
        S.suggestions.set(id, { state: 'working' });
        paint();
        const reply = await command({ type: 'router_suggest', system: id }, 'suggestion');
        S.busy.delete('suggest:' + id);
        if (reply.ok) S.suggestions.set(id, { suggestion: reply.suggestion || {} });
        else { S.suggestions.delete(id); note(id, reply.error || 'DGC couldn\'t work it out.', true); }
        paint();
    }
    async function apply(id) {
        S.busy.add('apply:' + id); paint();
        const reply = await command({ type: 'router_update', action: 'apply_suggestion', system: id });
        S.busy.delete('apply:' + id);
        if (reply.ok) { S.suggestions.delete(id); note(id, reply.change || 'Applied.'); }
        else note(id, reply.error || 'DGC didn\'t apply it.', true);
        paint();
    }
    async function remove(id) {
        S.removing = '';
        const reply = await command({ type: 'router_update', action: 'remove_system', system: id });
        if (!reply.ok) note(id, reply.error || 'DGC didn\'t remove it.', true);
        else { S.edits.delete(id); S.probes.delete(id); S.suggestions.delete(id); S.notes.delete(id); }
        paint();
    }
    async function cancelEdit(id) {
        const d = S.edits.get(id);
        S.edits.delete(id);
        if (d?.added) await remove(id);          // Cancel on a system being added takes it back out
        paint();
    }
    async function toggle() {
        const want = !on();
        S.switching = true; note('router', ''); paint();
        const reply = await command({ type: 'router_update', action: want ? 'turn_on' : 'turn_off' });
        S.switching = false;
        if (!reply.ok) note('router', reply.error || 'DGC didn\'t change it.', true);
        paint();
    }
    async function whenBusy(value) {
        const reply = await command({ type: 'router_update', action: 'set_when_busy', when_busy: value });
        if (!reply.ok) note('router', reply.error || 'DGC didn\'t change it.', true);
        paint();
    }
    async function find() {
        S.find = { state: 'looking' }; paint();
        const reply = await command({ type: 'router_find' }, 'found');
        S.find = reply.ok ? { state: 'found', found: reply.found || {} } : { state: 'found', error: reply.error || 'DGC couldn\'t look.' };
        paint();
    }

    // ---- drawing, and the clicks ----
    function paint() {
        const root = page();
        if (!root) { onPaint?.(); return; }
        // An open form keeps what was typed: read it before the redraw, focus goes back to the same field after.
        for (const id of S.edits.keys()) readForm(id);
        if (S.adding) {
            S.adding.address = document.getElementById('router-add-address')?.value ?? S.adding.address;
            S.adding.name = document.getElementById('router-add-name')?.value ?? S.adding.name;
        }
        const active = document.activeElement, within = root.contains(active);
        const focusKey = within ? focusOf(active) : null;
        const fresh = document.createElement('div');
        fresh.innerHTML = routerBlock();
        const next = fresh.firstElementChild;
        root.replaceWith(next);
        bind(next);
        if (focusKey) restoreFocus(next, focusKey);
        onPaint?.();
    }
    function focusOf(el) {
        const card = el.closest('[data-router-system]');
        const attrs = ['data-edit', 'data-i', 'value', 'id', 'data-router-test', 'data-router-suggest', 'data-router-edit', 'data-router-remove', 'data-router-edit-save', 'data-router-edit-test'];
        return { card: card?.dataset.routerSystem || '', id: el.id || '', attrs: attrs.filter(a => el.hasAttribute(a)).map(a => [a, el.getAttribute(a)]),
            start: el.selectionStart ?? null, end: el.selectionEnd ?? null };
    }
    function restoreFocus(root, key) {
        let el = key.id ? root.querySelector('#' + CSS.escape(key.id)) : null;
        if (!el) {
            const scope = key.card ? root.querySelector(`[data-router-system="${CSS.escape(key.card)}"]`) : root;
            const selector = key.attrs.map(([a, v]) => `[${a}="${CSS.escape(v)}"]`).join('');
            el = selector ? scope?.querySelector(selector) : null;
        }
        if (el && !el.disabled) {
            el.focus({ preventScroll: true });
            if (key.start !== null && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(key.start, key.end); } catch { /* a number box */ } }
        }
    }
    // "Last test (3 min ago)" stays true while Settings is open: only those words move on, nothing is redrawn (a form
    // being typed in keeps its place). It said "just now" for as long as nothing else redrew the card.
    let agoTimer = null;
    function keepAgoCurrent() {
        if (agoTimer || !document.querySelector('[data-router-ago]')) return;
        agoTimer = setInterval(() => {
            const shown = document.querySelectorAll('[data-router-ago]');
            if (!shown.length) { clearInterval(agoTimer); agoTimer = null; return; }
            for (const el of shown) { const words = ago(Number(el.dataset.routerAgo)); if (el.textContent !== words) el.textContent = words; }
        }, 15000);
    }
    function bind(root) {
        keepAgoCurrent();
        // Each model's Context each: the box, and what it costs there beside it (workers × context memory).
        bindContextCombos(root, { cost: (input, tokens) => {
            const id = input.closest('[data-router-system]')?.dataset.routerSystem, row = input.closest('[data-model-row]');
            const s = id ? system(id) : null;
            if (!s || !row) return '';
            const name = row.dataset.modelName;
            const facts = (s.models || []).find(x => x.name === name) || (s.available || []).find(x => x.name === name) || {};
            // What DGC will use: past the model's own maximum, that maximum (the box says so).
            const most = Number(facts.context_max) || 0;
            return contextCost(s, facts, most && tokens > most ? most : tokens, row.querySelector('[data-edit="workers"]')?.value);
        } });
        root.querySelectorAll('[data-model-row] [data-edit="workers"]').forEach(w => w.addEventListener('input', () => {
            w.closest('[data-model-row]')?.querySelector('[data-edit="context"]')?.dispatchEvent(new Event('change'));
        }));
        root.querySelector('[data-router-switch]')?.addEventListener('click', () => void toggle());
        root.querySelectorAll('input[name="router-when-busy"]').forEach(r => r.addEventListener('change', () => { if (r.checked) void whenBusy(r.value); }));
        root.querySelector('[data-router-add]')?.addEventListener('click', () => startAdd());
        root.querySelector('[data-router-find]')?.addEventListener('click', () => { S.find = { state: 'ask' }; paint(); });
        root.querySelector('[data-router-find-yes]')?.addEventListener('click', () => void find());
        root.querySelectorAll('[data-router-find-no]').forEach(b => b.addEventListener('click', () => { S.find = null; paint(); }));
        root.querySelectorAll('[data-router-found]').forEach(b => b.addEventListener('click', () => { const url = b.dataset.routerFound; S.find = null; startAdd(url); }));
        root.querySelector('[data-router-add-look]')?.addEventListener('click', () => void look());
        root.querySelector('[data-router-add-cancel]')?.addEventListener('click', () => { S.adding = null; paint(); });
        for (const id of ['router-add-address', 'router-add-name']) root.querySelector('#' + id)?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); void look(); } });
        const each = (attr, fn) => root.querySelectorAll(`[${attr}]`).forEach(b => b.addEventListener('click', () => fn(b.getAttribute(attr))));
        each('data-router-test', id => void test(id, false));
        root.querySelectorAll('[data-router-test-model]').forEach(b => b.addEventListener('click', () => {
            const id = b.closest('[data-router-system]')?.dataset.routerSystem;
            if (id) void test(id, false, b.dataset.routerTestModel);
        }));
        each('data-router-suggest', id => void suggest(id));
        each('data-router-suggest-close', id => { S.suggestions.delete(id); paint(); });
        each('data-router-apply', id => void apply(id));
        each('data-router-edit', id => { const s = system(id); if (s) { S.edits.set(id, draftFor(s)); S.notes.delete(id); paint(); } });
        each('data-router-remove', id => { S.removing = id; paint(); });
        each('data-router-remove-yes', id => void remove(id));
        root.querySelectorAll('[data-router-remove-no]').forEach(b => b.addEventListener('click', () => { S.removing = ''; paint(); }));
        each('data-router-edit-save', id => void save(id));
        each('data-router-edit-test', id => void test(id, true));
        each('data-router-edit-cancel', id => void cancelEdit(id));
        each('data-router-key', id => void useKey(id));
        root.querySelectorAll('[data-edit="offer"]').forEach(select => select.addEventListener('change', () => {
            const id = select.closest('[data-router-system]')?.dataset.routerSystem, d = readForm(id), s = system(id);
            const m = (s?.available || []).find(x => x.name === select.value);
            if (!d || !m) return;
            // Its context: the one it is loaded at now (so the server never reloads it), else what Suggest starts from.
            d.models.push({ name: m.name, use: true, workers: 1, context: Number(m.loaded_context) || Math.min(Number(m.context_max) || 32768, 32768),
                thinks: m.thinks, thinking: m.thinking || '', note: '', fresh: true });
            paint();
        }));
    }
    return {
        state: S, receive, setCapability, summary, routerBlock, bind, paint, on,
        capable: () => S.capable, pipsDefault: () => S.pipsDefault && S.capable, status: () => S.status,
    };
}
