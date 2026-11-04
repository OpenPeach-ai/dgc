// Settings -> Models -> Images: the image generators DGC makes pictures with (dgc/images.py, ready.capabilities.images).
// A row for each generator (its name, provider and model, price, whether it asks before each image, whether it works
// now, the Default badge, its key, this month's spend), + Add generator (a ComfyUI workflow's inputs confirmed on one
// screen first), Edit, Remove, Make default, Test and Test all; this project's choice, the automatic fallback and the
// folder images go in. Every change goes to DGC at once as an images_update command, never with the page's Save all.
// A key goes to DGC once (set_key) and is never sent back: the page only learns has_key and where a key comes from.
export const PROVIDERS = [
    ['comfyui', 'ComfyUI', 'On a computer of yours: any model it runs, and your own workflow if you like.'],
    ['a1111', 'Automatic1111, Forge, SD.Next or Draw Things', 'On a computer of yours.'],
    ['openai', 'OpenAI (GPT Image)', 'With your OpenAI key.'],
    ['gemini', 'Google Gemini and Imagen', 'With your Gemini API key.'],
    ['fal', 'fal.ai', 'One key for many models: FLUX, Seedream, Qwen-Image and more.'],
    ['replicate', 'Replicate', 'One key for many models.'],
    ['bfl', 'Black Forest Labs (FLUX)', 'With your Black Forest Labs key.'],
    ['xai', 'xAI', 'With your xAI key.'],
    ['together', 'Together', 'With your Together key.'],
    ['localai', 'LocalAI', 'On a computer of yours.'],
    ['ollama', 'Ollama', 'On a computer of yours. Its image generation is still experimental.'],
    ['openai_compatible', 'Another server with an OpenAI-style images API', 'Its address, and a key if it needs one.'],
];
// Video (0.51, dgc/videos.py): a video model is its own generator on the same provider and key. These make videos, each
// with the models DGC knows the price of (the first is the cheapest good one, the default).
export const VIDEO_PROVIDERS = [
    ['fal', 'fal.ai', 'The fal key your pictures use, or another.'],
    ['gemini', 'Google Gemini', 'A paid Gemini API project: video has no free tier.'],
    ['replicate', 'Replicate', 'The Replicate key your pictures use, or another.'],
    ['comfyui', 'ComfyUI with a video workflow', 'On a computer of yours: a Wan or LTX-Video workflow, exported in API format.'],
];
export const VIDEO_MODELS = {
    fal: [['fal-ai/wan/v2.2-5b/text-to-video', 'Wan 2.2 5B · $0.15 a clip (cheapest)'], ['fal-ai/ltxv-13b-098-distilled', 'LTX-Video 13B · $0.02/s'],
        ['fal-ai/minimax/hailuo-02/standard/text-to-video', 'Hailuo 02 · $0.045/s'], ['fal-ai/kling-video/v2.5-turbo/pro/text-to-video', 'Kling 2.5 Turbo Pro · $0.07/s'],
        ['fal-ai/wan-25-preview/text-to-video', 'Wan 2.5 · $0.05–0.15/s'], ['fal-ai/veo3/fast', 'Veo 3.1 Fast · $0.15/s, with sound']],
    gemini: [['gemini-omni-1.1-flash', 'Gemini Omni Flash · about $0.10/s, with sound'], ['veo-3.1-fast-generate-preview', 'Veo 3.1 Fast · $0.15/s (Google shut it down in the API)']],
    replicate: [['wan-video/wan-2.2-t2v-fast', 'Wan 2.2 fast · $0.05–0.10 a clip']],
};
const makesVideos = g => g?.makes === 'videos' || g?.makes === 'both';
const ON_YOUR_COMPUTER = new Set(['comfyui', 'a1111', 'localai', 'ollama', 'openai_compatible']);
const KEYED = new Set(['openai', 'xai', 'together', 'gemini', 'bfl', 'fal', 'replicate']);
const ADDRESS_HINT = { comfyui: 'http://localhost:8188', a1111: 'http://localhost:7860', localai: 'http://localhost:8080',
    ollama: 'http://localhost:11434', openai_compatible: 'http://gpu-box.local:8000/v1' };
const MODEL_HINT = { openai: 'gpt-image-1', xai: 'grok-2-image', together: 'black-forest-labs/FLUX.1-schnell', ollama: 'x/z-image-turbo',
    gemini: 'gemini-2.5-flash-image', bfl: 'flux-pro-1.1', fal: 'fal-ai/flux/schnell', replicate: 'black-forest-labs/flux-schnell',
    comfyui: 'The server\'s first checkpoint', a1111: 'The model it has loaded', localai: 'Its default', openai_compatible: 'Its default' };
/** A plain warning when a key doesn't look like a whole key of its provider (only where the shape is documented), else
 *  ''. The same rule as dgc/images_admin.key_shape_note: a fal key pasted in part was saved and every picture then
 *  failed as "Authentication is required" (2026-11-02). It never repeats the key. */
export function keyShapeNote(provider, key) {
    key = String(key || '').trim();
    if (!key) return '';
    if (provider === 'fal') {
        const at = key.indexOf(':');
        if (at <= 0 || at === key.length - 1)
            return "This doesn't look like a whole fal key: fal keys have two parts with a ':' between them (key ID : secret). Copy the whole key from fal.ai → API keys.";
    }
    if (provider === 'replicate' && !key.startsWith('r8_'))
        return "This doesn't look like a Replicate key: Replicate keys start with r8_. Copy it from replicate.com → API tokens.";
    if (provider === 'gemini' && !(key.startsWith('AIza') && key.length === 39))
        return "This doesn't look like a Gemini key: Google AI Studio keys start with AIza and are 39 characters. Copy it from aistudio.google.com → Get API key.";
    return '';
}
const KIND_WORDS = { needs_credit: 'Needs credit', rate_limited: 'Rate limited', bad_key: 'Bad key', server_down: 'Server down',
    refused: 'Refused', bad_request: 'Can\'t do that request', failed: 'Failed', cancelled: 'Stopped' };
export const MAPPING_WORDS = [['prompt', 'Prompt'], ['negative', 'Negative prompt'], ['seed', 'Seed'], ['steps', 'Steps'], ['width', 'Width'],
    ['height', 'Height'], ['batch', 'Images at once'], ['image', 'Input image (edits)'], ['mask', 'Mask'], ['denoise', 'Edit strength'],
    ['frames', 'Length (frames)'], ['fps', 'Frames per second']];
const MAPPING_TARGET = /^[A-Za-z0-9_:.-]{1,64}\.[A-Za-z0-9_]{1,64}$/;
const SIZE = /^\d{2,5}x\d{2,5}$/;

/** What a generator's state reads as: {cls, words, detail}. */
export function stateWords(g) {
    if (g?.enabled === false) return { cls: 'off', words: 'Turned off', detail: '' };
    // No key here: a "works" another DGC recorded (with a key of its own) says nothing about this one.
    if (KEYED.has(g?.provider) && g?.has_key === false) return { cls: 'bad', words: 'Needs a key', detail: '' };
    const state = g?.state;
    if (!state) return { cls: 'unknown', words: 'Not tested yet', detail: '' };
    if (state.ok) return { cls: 'ok', words: 'Works', detail: '' };
    // A saved key the provider refused: what to do, in the card's own words; the provider's sentence stays as detail.
    if (state.kind === 'bad_key' && g?.key_from === 'saved')
        return { cls: 'bad', words: 'Key not accepted: choose Edit and paste the whole key again', detail: String(state.detail || '') };
    return { cls: 'bad', words: KIND_WORDS[state.kind] || 'Failed', detail: String(state.detail || '') };
}
/** "$0.006", "$0.25", "$5.00": as the CLI writes dollars. */
export function dollars(value) {
    const n = Number(value) || 0;
    return n > 0 && n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}
/** Its key, in words (never the key): "Key saved", "Key from FAL_KEY", "No key yet", or "" for one that needs none. */
export function keyWords(g) {
    const from = String(g?.key_from || '');
    if (from === 'saved') return 'Key saved';
    if (from.startsWith('env:')) return `Key from ${from.slice(4)}`;
    if (KEYED.has(g?.provider)) return 'No key yet';
    return g?.provider === 'openai_compatible' && g?.has_key ? 'Key saved' : '';
}
/** This month's spend, for a generator that costs money: "This month: $0.01 of $5.00". */
export function spendWords(g) {
    if (!g?.paid) return '';
    const spent = dollars(g.spent_this_month_usd);
    // A limit is read against everything made on the generator's key this month, pictures and videos alike.
    const onKey = g.key_spent_this_month_usd !== undefined && Number(g.key_spent_this_month_usd) !== Number(g.spent_this_month_usd);
    return g.monthly_limit_usd !== undefined && g.monthly_limit_usd !== null
        ? `This month: ${dollars(onKey ? g.key_spent_this_month_usd : g.spent_this_month_usd)} of ${dollars(g.monthly_limit_usd)}${onKey ? ' on its key' : ''}`
        : `This month: ${spent}`;
}
/** "free · on your computer", "about $0.003 an image", "price unknown". */
export function priceWords(g) {
    if (g?.local) return 'free · on your computer';
    if (g?.price === 'free') return 'free';
    return Number(g?.price_usd) > 0 ? `${g.price} an image` : String(g?.price || 'price unknown');
}

export function createImages({ send, esc, switchHTML, ui, onPaint }) {
    const S = { capable: false, status: null, asked: 0, seq: 0, waiting: new Map(), busy: new Set(), notes: new Map(),
        edits: new Map(), adding: null, removing: '', error: '', workflows: new Map() };
    const page = () => document.getElementById('models-images');
    const gens = () => S.status?.generators || [];
    const gen = id => gens().find(g => g.id === id);
    const note = (key, text, error = false) => { if (text) S.notes.set(key, { text: String(text), error }); else S.notes.delete(key); };

    // ---- talking to DGC: one command, one answer (imagesReply), by token ----
    function command(cmd) {
        const token = `images-${++S.seq}`;
        return new Promise(resolve => { S.waiting.set(token, resolve); send({ type: 'imagesCommand', token, command: cmd }); });
    }
    function pickWorkflow() {
        const token = `images-${++S.seq}`;
        return new Promise(resolve => { S.workflows.set(token, resolve); send({ type: 'imagesPickWorkflow', token }); });
    }
    function receive(msg) {
        if (msg.type === 'imagesReply') {
            if (msg.status && typeof msg.status === 'object') S.status = msg.status;
            const done = S.waiting.get(msg.token);
            S.waiting.delete(msg.token);
            if (done) done(msg); else paint();
            return true;
        }
        if (msg.type === 'imagesWorkflow') {
            const done = S.workflows.get(msg.token);
            S.workflows.delete(msg.token);
            if (done) done(msg);
            return true;
        }
        if (msg.type === 'imagesMade') { if (S.capable) void refresh(); return true; }
        return false;
    }
    async function refresh() {
        S.asked = Date.now();
        const reply = await command({ type: 'images_list' });
        if (!reply.ok) S.error = reply.error || 'DGC didn\'t list the generators.';
        else S.error = '';
        paint();
    }
    function setCapability(config) {
        const was = S.capable;
        S.capable = config?.images_capable === true;
        S.videos = config?.videos_capable === true;      // + Add generator offers video models only then
        if (S.capable && !was) void refresh();
    }
    /** Models is on screen again: the list as it is now (spend, state), unless it was read a moment ago. */
    function shown() {
        if (S.capable && S.status && Date.now() - S.asked > 3000 && !S.busy.size && !S.waiting.size) void refresh();
    }

    // ---- the block ----
    function block() {
        if (!S.capable) return '';
        const s = S.status;
        const head = '<div class="router-head"><h4>Generators</h4><span class="actions">'
            + `<button type="button" class="secondary" data-images-add${S.adding ? ' disabled' : ''}>+ Add generator</button>`
            + (gens().length ? `<button type="button" class="secondary" data-images-test-all${S.busy.has('all') ? ' disabled' : ''}>${S.busy.has('all') ? 'Testing…' : 'Test all'}</button>` : '')
            + '</span></div>';
        const list = !s ? `<p class="router-empty" role="status">${S.error ? esc(S.error) : 'Reading your generators…'}</p>`
            : (S.adding ? addCard() : '') + (gens().length ? gens().map(card).join('')
                : (S.adding ? '' : '<p class="router-empty">No generators yet. Add ComfyUI or Automatic1111 on a computer of yours, or a key for OpenAI, Gemini, fal.ai and others.</p>'));
        const said = S.notes.get('all');
        const failed = (s && S.error ? `<p class="router-note error" role="alert">${esc(S.error)}</p>` : '')
            + (said ? `<p class="router-note${said.error ? ' error' : ''}" role="status">${esc(said.text)}</p>` : '');
        // "Images & video" with a CLI that makes videos (ready.capabilities.videos); an older one's is "Images", as it was.
        return '<section class="group" id="models-images" data-block="images">'
            + (S.videos ? '<h3>Images &amp; video</h3><p class="group-note">What DGC makes a picture or a short video with when you ask, in Work, ChatDGC and your Pips. Every video shows its price and asks first.</p>'
                : '<h3>Images</h3><p class="group-note">What DGC makes a picture with when you ask for one, in Work, ChatDGC and your Pips.</p>')
            + `<div class="images-gens">${head}<div class="router-list">${list}</div>${failed}</div>`
            + (s ? options(s) : '') + '</section>';
    }
    function options(s) {
        const choice = String(s.project_choice || '');
        const choices = [['', 'Ask me when several fit']].concat(gens().map(g => [g.id, g.name]));
        if (choice && !gens().some(g => g.id === choice)) choices.push([choice, `${choice} (removed)`]);
        const rows = ui.field('This project uses', 'DGC asks once, then remembers.', ui.sel('images-project', choices, choice),
                'For the project open in this window. You can always name another in words: “use ComfyUI for this”.')
            + ui.field('When one needs credit', 'Use another that fits. A paid one still asks.',
                switchHTML(s.auto_fallback === true, 'When one needs credit, use another that fits', 'id="images-fallback" data-images-fallback', S.busy.has('fallback')),
                'Off: DGC switches by itself only to a free one, and offers you the rest.')
            + '<div class="field images-dir"><span class="words"><span class="name-line"><label class="name" for="images-save-dir">Save images in</label></span>'
            + '<span class="hint" title="Blank keeps pictures in DGC\'s own folder, and puts one in the project only when you ask. A folder here puts every picture in the project.">Blank: DGC\'s own folder.</span></span><span class="router-inline">'
            + `<input id="images-save-dir" type="text" value="${esc(s.save_dir || '')}" placeholder="DGC's own folder" aria-label="Save images in: blank for DGC's own folder, or a folder in the project" autocomplete="off" spellcheck="false">`
            + `<button type="button" class="secondary" data-images-save-dir${S.busy.has('dir') ? ' disabled' : ''}>Save</button></span></div>`;
        const dirNote = S.notes.get('dir') ? `<p class="router-note${S.notes.get('dir').error ? ' error' : ''}" role="status">${esc(S.notes.get('dir').text)}</p>` : '';
        const plugins = (s.through_plugins || []).filter(Boolean);
        const through = plugins.length ? `<p class="images-plugins">${esc(plugins.join(' and '))} work through their plugins. <button type="button" class="link" data-images-plugins>Plugins</button></p>` : '';
        return `<div class="rows images-options">${rows}</div>${dirNote}${through}<p class="router-saved">Changes here are saved as you make them.</p>`;
    }
    function systemName(id) {
        const systems = ui.router?.status?.()?.systems || [];
        return systems.find(x => x.id === id)?.name || id;
    }
    function card(g) {
        const edit = S.edits.get(g.id);
        const state = stateWords(g);
        const head = `<div class="router-card-head"><span class="router-dot ${state.cls === 'ok' ? 'online' : state.cls === 'bad' ? 'offline' : state.cls}" aria-hidden="true"></span>`
            + `<span class="router-name">${esc(g.name)}</span>${g.default ? '<span class="images-badge">Default</span>' : ''}`
            + `<span class="router-where">${esc(g.provider_name || g.provider)}${g.model ? ' · ' + esc(g.model) : g.workflow ? ' · your workflow' : ''}</span>`
            + `<span class="images-state ${state.cls}" data-images-state="${esc(g.id)}">${esc(state.words)}</span></div>`;
        if (edit) return `<article class="router-card images-card editing" data-images-gen="${esc(g.id)}">${head}${editForm(g, edit)}</article>`;
        const busy = key => S.busy.has(`${key}:${g.id}`) || S.busy.has('all');
        const key = keyWords(g), spend = spendWords(g);
        const v = g.video || {};
        const facts = makesVideos(g) && g.makes === 'videos'
            ? ['Makes videos', esc(v.price_per_s || 'price unknown'), esc(v.minutes || ''),
                v.durations?.length ? `${v.durations.length > 3 ? `${v.durations[0]}–${v.durations[v.durations.length - 1]}` : v.durations.join(', ')} s` : '',
                (v.resolutions || []).map(esc).join(', '), v.audio === 'always' ? 'with sound' : v.audio === 'option' ? 'sound if asked' : '']
                .filter(Boolean).join(' · ')
            : [esc(priceWords(g)), g.size ? `${esc(g.size)} by default` : '', makesVideos(g) ? `and videos: ${esc(v.price_per_s || '')}` : '']
                .filter(Boolean).join(' · ');
        const n = S.notes.get(g.id);
        const lines = `<p class="router-line">${facts}</p>`
            + (state.detail ? `<p class="router-line muted images-detail">${esc(state.detail)}</p>` : '')
            + (key || spend ? `<p class="router-line">${[key ? `<span class="${key === 'No key yet' ? 'router-bad' : ''}">${esc(key)}</span>` : '', esc(spend)].filter(Boolean).join(' · ')}</p>` : '')
            + (g.system ? `<p class="router-line">On DGC Router: ${esc(systemName(g.system))} <button type="button" class="link" data-images-router>See systems</button></p>` : '')
            + (v.note ? `<p class="router-line muted">${esc(v.note)}</p>` : '')
            + (v.pips?.length ? `<p class="router-line">Pips whose routines may make its videos: ${v.pips.map(esc).join(', ')}</p>` : '');
        const pictures = g.makes !== 'videos';
        const asks = (pictures ? `<div class="images-asks"><label class="name" for="images-asks-${esc(g.id)}">Asks before each image</label>`
            + switchHTML(g.asks === true, `Asks before each image: ${g.name}`, `id="images-asks-${esc(g.id)}" data-images-asks="${esc(g.id)}"`, busy('asks'))
            + `<span class="hint">${g.asks ? 'Shows the price first.' : g.paid ? 'Makes it without asking.' : 'Free: nothing to ask.'}</span></div>` : '')
            // A video's card is the only Always allow there is: on by default, off only here, for this generator.
            + (makesVideos(g) ? `<div class="images-asks"><label class="name" for="images-video-asks-${esc(g.id)}">Asks before each video</label>`
            + switchHTML(g.video?.asks !== false, `Asks before each video: ${g.name}`, `id="images-video-asks-${esc(g.id)}" data-images-video-asks="${esc(g.id)}"`, busy('vasks'))
            + `<span class="hint">${g.video?.asks !== false ? 'Shows the price first, every time.' : 'Makes videos without asking: your choice here.'}</span></div>` : '');
        const removing = S.removing === g.id ? `<div class="router-confirm" role="group" aria-label="Remove ${esc(g.name)}"><span>Remove ${esc(g.name)}?${g.key_from === 'saved' ? ' Its saved key goes too.' : ''}</span><button type="button" class="secondary danger" data-images-remove-yes="${esc(g.id)}">Remove</button><button type="button" class="secondary" data-images-remove-no>Keep it</button></div>` : '';
        const buttons = S.removing === g.id ? '' : `<div class="actions router-buttons"><button type="button" class="secondary" data-images-test="${esc(g.id)}"${busy('test') ? ' disabled' : ''}>${busy('test') ? 'Testing…' : 'Test'}</button>`
            + `<button type="button" class="secondary" data-images-edit="${esc(g.id)}">Edit</button>`
            + (g.default ? '' : `<button type="button" class="secondary" data-images-default="${esc(g.id)}"${busy('default') ? ' disabled' : ''}>Make default</button>`)
            + `<button type="button" class="secondary" data-images-remove="${esc(g.id)}">Remove</button></div>`;
        return `<article class="router-card images-card" data-images-gen="${esc(g.id)}">${head}${lines}${asks}`
            + (n ? `<p class="router-note${n.error ? ' error' : ''}" role="status">${esc(n.text)}</p>` : '') + removing + buttons + '</article>';
    }

    // ---- + Add generator ----
    function addCard() {
        const a = S.adding;
        if (a.pending) return mappingCard(a);
        const busy = a.state === 'adding';
        const local = ON_YOUR_COMPUTER.has(a.provider), keyed = KEYED.has(a.provider) || a.provider === 'openai_compatible';
        const video = a.makes === 'videos';
        a.drawnFor = a.makes;                       // the provider box drawn below is this choice's list
        const list = video ? VIDEO_PROVIDERS : PROVIDERS;
        if (!list.some(p => p[0] === a.provider)) a.provider = list[0][0];
        const about = (list.find(p => p[0] === a.provider) || [])[2] || '';
        const dis = busy ? ' disabled' : '';
        const models = video ? VIDEO_MODELS[a.provider] || [] : [];
        const workflow = a.provider === 'comfyui'
            ? `<fieldset class="router-hardware images-workflow"><legend>Workflow ${video ? '' : '<small>(optional)</small>'}</legend>`
                + (a.workflowName ? `<p class="router-line">${esc(a.workflowName)} <button type="button" class="link" data-images-workflow-clear${dis}>${video ? 'Choose none' : 'Use DGC\'s own instead'}</button></p>`
                    : video ? '<p class="router-line muted">A video needs your own workflow: Wan 2.2 or LTX-Video, exported in API format.</p>'
                    : '<p class="router-line muted">Without one, DGC uses its own text-to-image workflow with the model above.</p>')
                + `<div class="actions"><button type="button" class="secondary" data-images-workflow-pick${dis}>${a.workflowName ? 'Choose another…' : 'Choose a workflow file…'}</button></div>`
                + `<details class="more images-paste"${a.pasteOpen ? ' open' : ''}><summary>Paste it instead</summary><textarea id="images-add-workflow" rows="5" spellcheck="false" placeholder="{ &quot;3&quot;: { &quot;class_type&quot;: &quot;KSampler&quot;, … } }"${dis}>${esc(a.workflowText && !a.workflowName ? a.workflowText : '')}</textarea></details>`
                + '<p class="muted">In ComfyUI: Workflow → Export (API). DGC finds its prompt, seed, size and input image and shows you that first.</p></fieldset>'
            : '';
        return '<article class="router-card adding" data-images-adding><div class="router-card-head"><span class="router-name">Add a generator</span></div><div class="router-form">'
            + (S.videos ? `<label class="router-field"><span>It makes</span><select id="images-add-makes"${dis}><option value="images"${video ? '' : ' selected'}>Pictures</option><option value="videos"${video ? ' selected' : ''}>Videos</option></select></label>` : '')
            + `<label class="router-field"><span>Provider</span><select id="images-add-provider"${dis}>${list.map(([id, label]) => `<option value="${id}"${id === a.provider ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`
            + `<p class="muted images-about">${esc(about)}</p>`
            + (local ? `<label class="router-field"><span>Address${a.provider === 'openai_compatible' ? '' : ' <small>(blank: this computer)</small>'}</span><input id="images-add-address" type="text" value="${esc(a.address)}" placeholder="${esc(ADDRESS_HINT[a.provider] || '')}" autocomplete="off" spellcheck="false"${dis}></label>` : '')
            + `<div class="router-grid"><label class="router-field"><span>Name <small>(optional)</small></span><input id="images-add-name" type="text" value="${esc(a.name)}" maxlength="64" autocomplete="off" spellcheck="false"${dis}></label>`
            + (models.length ? `<label class="router-field"><span>Model</span><select id="images-add-video-model"${dis}>${models.map(([id, label]) => `<option value="${esc(id)}"${id === (a.model || models[0][0]) ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label></div>`
                : video ? '</div>'
                : `<label class="router-field"><span>Model <small>(optional)</small></span><input id="images-add-model" type="text" value="${esc(a.model)}" placeholder="${esc(MODEL_HINT[a.provider] || '')}" autocomplete="off" spellcheck="false"${dis}></label></div>`)
            + (keyed ? `<label class="router-field"><span>Key${a.provider === 'openai_compatible' ? ' <small>(only if it needs one)</small>' : video ? ' <small>(blank: the key its pictures use)</small>' : ''}</span><input id="images-add-key" type="password" value="${esc(a.key)}" placeholder="${video ? 'The same key as its pictures' : 'Paste its key'}" autocomplete="off" spellcheck="false"${dis}><small>It goes to DGC once, for this generator only, and is never shown again.</small></label>` : '')
            + workflow
            + (a.error ? `<p class="router-note error" role="alert">${esc(a.error)}</p>` : '')
            + `<div class="actions"><button type="button" class="save" data-images-add-go${dis}>${busy ? (a.provider === 'comfyui' && !a.workflowText ? 'Looking at it…' : 'Adding…') : a.provider === 'comfyui' && (a.workflowText || '').trim() ? 'Next' : 'Add'}</button>`
            + `<button type="button" class="secondary" data-images-add-cancel${dis}>Cancel</button></div></div></article>`;
    }
    /** A workflow's inputs, one screen: what DGC found where (each "NODE.input", which the user may change). */
    function mappingRows(mapping, lines, editable, busy) {
        const present = MAPPING_WORDS.filter(([key]) => mapping[key] !== undefined);
        const said = new Map(present.map(([key], i) => [key, String(lines?.[i] || '').split(' → ').slice(1).join(' → ')]));
        return '<div class="router-models images-mapping" role="table" aria-label="Where the workflow takes each input">'
            + '<div class="router-model head" role="row"><span role="columnheader">Input</span><span role="columnheader">Node and field</span><span role="columnheader">What it is</span></div>'
            + present.map(([key, words]) => `<div class="router-model" role="row"><span role="cell">${esc(words)}</span>`
                + `<span role="cell">${editable ? `<input type="text" data-map-key="${key}" value="${esc(mapping[key])}" aria-label="${esc(words)}: node and field" autocomplete="off" spellcheck="false"${busy ? ' disabled' : ''}>` : esc(mapping[key])}</span>`
                + `<span role="cell" class="muted">${esc(said.get(key) || '')}</span></div>`).join('') + '</div>';
    }
    function mappingCard(a) {
        const p = a.pending, busy = a.state === 'adding';
        const notes = (p.notes || []).filter(Boolean);
        return '<article class="router-card adding" data-images-adding data-images-mapping><div class="router-card-head"><span class="router-name">Check the workflow\'s inputs</span></div><div class="router-form">'
            + `<p class="router-line">DGC found these in ${esc(a.workflowName || 'the workflow')}. Change one if it's wrong (each is a node and its field, like 6.text), then add it.</p>`
            + mappingRows(p.mapping || {}, p.mapping_lines || [], true, busy)
            + (notes.length ? `<ul class="images-notes">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '')
            + (a.error ? `<p class="router-note error" role="alert">${esc(a.error)}</p>` : '')
            + `<div class="actions"><button type="button" class="save" data-images-mapping-yes${busy ? ' disabled' : ''}>${busy ? 'Adding…' : 'Add with these'}</button>`
            + `<button type="button" class="secondary" data-images-mapping-back${busy ? ' disabled' : ''}>Back</button>`
            + `<button type="button" class="secondary" data-images-add-cancel${busy ? ' disabled' : ''}>Cancel</button></div></div></article>`;
    }
    function startAdd() {
        S.adding = { makes: 'images', provider: 'comfyui', address: '', name: '', model: '', key: '', workflowText: '', workflowName: '', pasteOpen: false, state: '', error: '', pending: null };
        paint();
        queueMicrotask(() => document.getElementById('images-add-provider')?.focus());
    }
    function readAdd() {
        const a = S.adding;
        if (!a) return a;
        const val = id => document.getElementById(id);
        if (!a.pending) {
            const makes = val('images-add-makes')?.value ?? a.makes;
            // A new choice of what it makes starts that list's first provider. The provider box on screen still shows
            // the old list until the card is drawn again, so it is read only when it was drawn for this choice (a
            // browser sends both input and change for one choice, and each reads the form).
            if (makes !== a.makes) { a.makes = makes; a.model = ''; a.provider = makes === 'videos' ? 'fal' : 'comfyui'; }
            else if (a.drawnFor === a.makes) a.provider = val('images-add-provider')?.value ?? a.provider;
            if (val('images-add-video-model')) a.model = val('images-add-video-model').value;
            a.address = val('images-add-address')?.value ?? a.address;
            a.name = val('images-add-name')?.value ?? a.name;
            a.model = val('images-add-model')?.value ?? a.model;
            a.key = val('images-add-key')?.value ?? a.key;
            const pasted = val('images-add-workflow');
            if (pasted && !a.workflowName) a.workflowText = pasted.value;
            const paste = document.querySelector('.images-paste');
            if (paste) a.pasteOpen = paste.open;
        } else {
            document.querySelectorAll('[data-images-mapping] [data-map-key]').forEach(box => { a.pending.mapping[box.dataset.mapKey] = box.value; });
        }
        return a;
    }
    async function add() {
        const a = readAdd();
        if (!a) return;
        a.error = '';
        const address = a.address.trim();
        if (a.provider === 'openai_compatible' && !address) { a.error = 'Type its address first.'; paint(); return; }
        const shape = keyShapeNote(a.provider, a.key);
        if (shape && a.keyWarned !== a.key.trim()) { a.keyWarned = a.key.trim(); a.error = `${shape} Choose Add again to save it anyway.`; paint(); return; }
        if (a.makes === 'videos' && a.provider === 'comfyui' && !a.workflowText.trim()) { a.error = 'A ComfyUI video generator needs its workflow: choose the file you exported (API format).'; paint(); return; }
        const cmd = { type: 'images_update', action: 'add_generator', provider: a.provider, ...(a.makes === 'videos' ? { makes: 'videos' } : {}),
            ...(address ? { base_url: address } : {}), ...(a.name.trim() ? { name: a.name.trim() } : {}),
            ...(a.model.trim() ? { model: a.model.trim() } : {}) };
        if (a.provider === 'comfyui' && a.workflowText.trim()) {
            try { cmd.workflow = JSON.parse(a.workflowText); }
            catch { a.error = 'That isn\'t a workflow DGC can read: in ComfyUI use Workflow → Export (API), and choose that file.'; paint(); return; }
            if (!cmd.workflow || typeof cmd.workflow !== 'object' || Array.isArray(cmd.workflow)) { a.error = 'That isn\'t a ComfyUI workflow.'; paint(); return; }
        }
        a.state = 'adding'; paint();
        const before = new Set(gens().map(g => g.id));
        const reply = await command(cmd);
        if (!reply.ok) { a.state = ''; a.error = reply.error || 'DGC couldn\'t add it.'; paint(); return; }
        if (reply.pending) {
            a.state = '';
            a.pending = { ...reply.pending, mapping: { ...(reply.pending.mapping || {}) }, cmd };
            paint();
            queueMicrotask(() => document.querySelector('[data-images-mapping] [data-map-key]')?.focus());
            return;
        }
        await added(reply, before, a);
    }
    async function confirmMapping() {
        const a = readAdd();
        if (!a?.pending) return;
        a.error = '';
        const mapping = {};
        for (const [key, target] of Object.entries(a.pending.mapping)) {
            const value = String(target || '').trim();
            if (!value) continue;
            if (!MAPPING_TARGET.test(value)) { a.error = `${(MAPPING_WORDS.find(w => w[0] === key) || [key, key])[1]}: write it as a node and its field, like 6.text.`; paint(); return; }
            mapping[key] = value;
        }
        if (!mapping.prompt) { a.error = 'Say where the prompt goes, like 6.text.'; paint(); return; }
        a.state = 'adding'; paint();
        const before = new Set(gens().map(g => g.id));
        const reply = await command({ ...a.pending.cmd, mapping });
        if (!reply.ok) { a.state = ''; a.error = reply.error || 'DGC couldn\'t add it.'; paint(); return; }
        await added(reply, before, a);
    }
    /** The generator is in: its key goes in its own command, then one test, and the card says how it went. */
    async function added(reply, before, a) {
        const fresh = gens().find(g => !before.has(g.id));
        if (!fresh) { a.state = ''; a.error = 'DGC added nothing.'; paint(); return; }
        let tested = reply.tested?.[fresh.id];
        let keyError = '';
        if (a.key.trim()) {
            const saved = await command({ type: 'images_update', action: 'set_key', generator: fresh.id, key: a.key.trim() });
            a.key = '';
            if (!saved.ok) keyError = saved.error || 'DGC didn\'t keep the key.';
            else {
                const again = await command({ type: 'images_update', action: 'test', generator: fresh.id });
                if (again.ok && again.tested?.[fresh.id]) tested = again.tested[fresh.id];
            }
        }
        S.adding = null;
        const checkpoint = (reply.notes || []).find(n => /^Uses the checkpoint/.test(String(n)));
        const g = gen(fresh.id) || fresh;
        // How the first test went; what the provider said is on the card's state line already.
        const how = keyError ? `Added, but the key wasn't kept: ${keyError}`
            : !tested ? 'Added.'
            : tested.ok ? 'Added. It works.'
            : `Added, but it doesn't work yet.${KEYED.has(g.provider) && !g.has_key ? ' Choose Edit to add its key.' : ''}`;
        note(fresh.id, [how, checkpoint].filter(Boolean).join(' '), !!keyError || (tested && !tested.ok));
        paint();
        queueMicrotask(() => document.querySelector(`[data-images-gen="${CSS.escape(fresh.id)}"] [data-images-test]`)?.focus());
    }
    async function chooseWorkflow() {
        const a = readAdd();
        if (!a) return;
        const picked = await pickWorkflow();
        if (!S.adding) return;
        if (picked.error) { a.error = picked.error; paint(); return; }
        if (picked.cancelled || typeof picked.text !== 'string') return;
        a.workflowText = picked.text; a.workflowName = String(picked.name || 'workflow.json'); a.error = '';
        paint();
    }

    // ---- Edit ----
    function draftFor(g) {
        return { name: g.name, base_url: g.base_url || '', model: g.model || '', size: g.size || '', good_for: g.good_for || '',
            limit: g.monthly_limit_usd ?? '', enabled: g.enabled !== false, system: g.system || '', key: '',
            mapping: { ...(g.mapping || {}) }, state: '', error: '' };
    }
    function editForm(g, d) {
        const busy = d.state ? ' disabled' : '';
        const systems = (ui.router?.status?.()?.systems || []).filter(x => (x.jobs || []).includes('images'));
        const moved = String(d.base_url).trim() !== String(g.base_url || '');
        const keyed = KEYED.has(g.provider) || g.provider === 'openai_compatible';
        return '<div class="router-form">'
            + `<div class="router-grid"><label class="router-field"><span>Name</span><input type="text" data-edit="name" value="${esc(d.name)}" maxlength="64"${busy}></label>`
            + `<label class="router-field"><span>Address</span><input type="text" data-edit="base_url" value="${esc(d.base_url)}" autocomplete="off" spellcheck="false"${busy}>`
            + `<small data-images-moved${moved && g.key_from === 'saved' ? '' : ' hidden'}>Changing the address removes its saved key.</small></label></div>`
            + `<div class="router-grid"><label class="router-field"><span>Model</span><input type="text" data-edit="model" value="${esc(d.model)}" placeholder="${esc(MODEL_HINT[g.provider] || '')}" autocomplete="off" spellcheck="false"${busy}></label>`
            + `<label class="router-field"><span>Size <small>(width x height)</small></span><input type="text" data-edit="size" value="${esc(d.size)}" placeholder="1024x1024" autocomplete="off" spellcheck="false"${busy}></label></div>`
            + `<label class="router-field"><span>Good for <small>(what the model reads about it)</small></span><input type="text" data-edit="good_for" value="${esc(d.good_for)}" maxlength="200"${busy}></label>`
            + (g.paid ? `<label class="router-field"><span>Monthly limit, $ <small>(blank: none; past it, DGC asks again)</small></span><input type="number" min="0" step="any" data-edit="limit" value="${esc(d.limit)}"${busy}></label>` : '')
            + (keyed ? `<label class="router-field"><span>Key${g.provider === 'openai_compatible' ? ' <small>(only if it needs one)</small>' : ''}</span><span class="router-inline"><input type="password" data-edit="key" value="${esc(d.key)}" placeholder="${g.key_from === 'saved' ? 'Saved' : String(g.key_from || '').startsWith('env:') ? `From ${esc(g.key_from.slice(4))}` : 'Paste its key'}" autocomplete="off" spellcheck="false"${busy}>`
                + (g.key_from === 'saved' ? `<button type="button" class="secondary" data-images-key-remove="${esc(g.id)}"${busy}>Remove the key</button>` : '') + '</span></label>' : '')
            + (systems.length || g.system ? `<label class="router-field"><span>DGC Router system <small>(a computer with the images job)</small></span><select data-edit="system"${busy}><option value="">None</option>`
                + systems.map(x => `<option value="${esc(x.id)}"${x.id === d.system ? ' selected' : ''}>${esc(x.name)}</option>`).join('')
                + (d.system && !systems.some(x => x.id === d.system) ? `<option value="${esc(d.system)}" selected>${esc(d.system)}</option>` : '') + '</select></label>' : '')
            + (g.workflow ? `<fieldset class="router-hardware"><legend>Your workflow · ${esc(g.workflow)}</legend>${mappingRows(d.mapping, [], true, !!d.state)}</fieldset>` : '')
            + `<label class="router-check"><input type="checkbox" data-edit="enabled"${d.enabled ? ' checked' : ''}${busy}> Use this generator</label>`
            + (d.error ? `<p class="router-note error" role="alert">${esc(d.error)}</p>` : '')
            + `<div class="actions"><button type="button" class="save" data-images-edit-save="${esc(g.id)}"${busy}>${d.state === 'saving' ? 'Saving…' : 'Save'}</button>`
            + `<button type="button" class="secondary" data-images-edit-cancel="${esc(g.id)}"${busy}>Cancel</button></div></div>`;
    }
    function readEdit(id) {
        const d = S.edits.get(id), root = document.querySelector(`[data-images-gen="${CSS.escape(id)}"] .router-form`);
        if (!d || !root) return d;
        const val = sel => root.querySelector(sel);
        for (const field of ['name', 'base_url', 'model', 'size', 'good_for', 'limit', 'key', 'system']) {
            const box = val(`[data-edit="${field}"]`);
            if (box) d[field] = box.value;
        }
        d.enabled = val('[data-edit="enabled"]')?.checked ?? d.enabled;
        root.querySelectorAll('[data-map-key]').forEach(box => { d.mapping[box.dataset.mapKey] = box.value; });
        return d;
    }
    /** The edit an open form makes, as one edit_generator; throws a plain reason for a bad value. */
    function editChange(g, d) {
        const out = {};
        const name = String(d.name).trim(), base = String(d.base_url).trim(), size = String(d.size).trim().toLowerCase();
        if (!name) throw new Error('Give it a name.');
        if (size && !SIZE.test(size)) throw new Error('Write the size as width x height, like 1024x1024.');
        if (name !== g.name) out.name = name;
        if (base && base !== g.base_url) out.base_url = base;
        if (String(d.model).trim() !== String(g.model || '')) out.model = String(d.model).trim();
        if (size && size !== g.size) out.size = size;
        if (String(d.good_for).trim() !== String(g.good_for || '')) out.good_for = String(d.good_for).trim();
        if (d.enabled !== (g.enabled !== false)) out.enabled = d.enabled;
        if (String(d.system) !== String(g.system || '')) out.system = String(d.system);
        if (g.paid) {
            const raw = String(d.limit ?? '').trim();
            const had = g.monthly_limit_usd !== undefined && g.monthly_limit_usd !== null;
            if (!raw) { if (had) out.monthly_limit_usd = -1; }
            else {
                const limit = Number(raw);
                if (!(limit >= 0 && limit <= 100000)) throw new Error('The monthly limit takes an amount in dollars, or leave it blank.');
                if (!had || limit !== Number(g.monthly_limit_usd)) out.monthly_limit_usd = limit;
            }
        }
        if (g.workflow) {
            const mapping = {};
            for (const [key, target] of Object.entries(d.mapping)) {
                const value = String(target || '').trim();
                if (!value) continue;
                if (!MAPPING_TARGET.test(value)) throw new Error(`${(MAPPING_WORDS.find(w => w[0] === key) || [key, key])[1]}: write it as a node and its field, like 6.text.`);
                mapping[key] = value;
            }
            if (!mapping.prompt) throw new Error('Say where the prompt goes, like 6.text.');
            if (JSON.stringify(mapping) !== JSON.stringify(g.mapping || {})) out.mapping = mapping;
        }
        return out;
    }
    async function saveEdit(id) {
        const g = gen(id), d = readEdit(id);
        if (!g || !d) return;
        d.error = '';
        let change;
        try { change = editChange(g, d); } catch (error) { d.error = error.message; paint(); return; }
        const shape = keyShapeNote(g.provider, d.key);
        if (shape && d.keyWarned !== String(d.key).trim()) { d.keyWarned = String(d.key).trim(); d.error = `${shape} Choose Save again to save it anyway.`; paint(); return; }
        d.state = 'saving'; paint();
        const said = [];
        if (Object.keys(change).length) {
            const reply = await command({ type: 'images_update', action: 'edit_generator', generator: id, ...change });
            if (!reply.ok) { d.state = ''; d.error = reply.error || 'DGC didn\'t save it.'; paint(); return; }
            said.push('Saved.');
            if (change.base_url && g.key_from === 'saved') said.push('Its saved key was removed with the old address.');
        }
        if (String(d.key).trim()) {
            const reply = await command({ type: 'images_update', action: 'set_key', generator: id, key: String(d.key).trim() });
            d.key = '';
            if (!reply.ok) { d.state = ''; d.error = reply.error || 'DGC didn\'t keep the key.'; paint(); return; }
            said.push('Key saved.');
        }
        S.edits.delete(id);
        note(id, said.join(' ') || '');
        paint();
        // A new key or address is worth one test at once.
        if (change.base_url || said.includes('Key saved.')) void test(id, said.join(' '));
    }
    async function removeKey(id) {
        const d = readEdit(id);
        if (d) { d.state = 'saving'; paint(); }
        const reply = await command({ type: 'images_update', action: 'set_key', generator: id, key: '' });
        if (d) { d.state = ''; if (!reply.ok) d.error = reply.error || 'DGC didn\'t remove the key.'; }
        if (reply.ok) note(id, 'Key removed.');
        paint();
    }

    // ---- the rest ----
    async function simple(busyKey, cmd, noteKey, fallbackError) {
        S.busy.add(busyKey); paint();
        const reply = await command(cmd);
        S.busy.delete(busyKey);
        if (!reply.ok) note(noteKey, reply.error || fallbackError, true);
        paint();
        return reply;
    }
    /** One generator's test: its state line says the answer; `said` (what a save just did) stays beside it. */
    async function test(id, said = '') {
        note(id, said);
        const reply = await simple(`test:${id}`, { type: 'images_update', action: 'test', generator: id }, id, 'The test didn\'t run.');
        const tested = reply.ok ? reply.tested?.[id] : null;
        if (tested) { note(id, [said, tested.ok ? 'Tested: it works.' : ''].filter(Boolean).join(' '), false); paint(); }
    }
    async function testAll() {
        S.notes.clear();
        await simple('all', { type: 'images_list', refresh: true }, 'all', 'The test didn\'t run.');
    }
    function bind(root) {
        const each = (attr, fn) => root.querySelectorAll(`[${attr}]`).forEach(b => b.addEventListener('click', () => fn(b.getAttribute(attr))));
        root.querySelector('[data-images-add]')?.addEventListener('click', () => startAdd());
        root.querySelector('[data-images-test-all]')?.addEventListener('click', () => void testAll());
        root.querySelector('[data-images-add-go]')?.addEventListener('click', () => void add());
        root.querySelectorAll('[data-images-add-cancel]').forEach(b => b.addEventListener('click', () => { S.adding = null; paint(); root.querySelector('[data-images-add]')?.focus(); }));
        const changeProvider = () => {
            readAdd();
            Object.assign(S.adding, { model: '', address: '', key: '', keyWarned: '', workflowText: '',
                workflowName: '', pasteOpen: false, pending: null, error: '' });
            paint(false);                     // the old provider's inputs no longer describe this draft
        };
        root.querySelector('#images-add-provider')?.addEventListener('change', changeProvider);
        root.querySelector('#images-add-makes')?.addEventListener('change', changeProvider);
        root.querySelector('[data-images-workflow-pick]')?.addEventListener('click', () => void chooseWorkflow());
        root.querySelector('[data-images-workflow-clear]')?.addEventListener('click', () => { readAdd(); Object.assign(S.adding, { workflowText: '', workflowName: '' }); paint(); });
        root.querySelector('[data-images-mapping-yes]')?.addEventListener('click', () => void confirmMapping());
        root.querySelector('[data-images-mapping-back]')?.addEventListener('click', () => { readAdd(); S.adding.pending = null; S.adding.error = ''; paint(); });
        for (const id of ['images-add-address', 'images-add-name', 'images-add-model', 'images-add-key']) {
            root.querySelector('#' + id)?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); void add(); } });
        }
        each('data-images-test', id => void test(id));
        each('data-images-edit', id => { const g = gen(id); if (g) { S.edits.set(id, draftFor(g)); note(id, ''); paint(); queueMicrotask(() => document.querySelector(`[data-images-gen="${CSS.escape(id)}"] [data-edit="name"]`)?.focus()); } });
        each('data-images-edit-save', id => void saveEdit(id));
        each('data-images-edit-cancel', id => { S.edits.delete(id); paint(); });
        each('data-images-key-remove', id => void removeKey(id));
        each('data-images-default', id => void simple(`default:${id}`, { type: 'images_update', action: 'set_default', generator: id }, id, 'DGC didn\'t change it.'));
        each('data-images-video-asks', id => { const g = gen(id); if (g) void simple(`vasks:${id}`, { type: 'images_update', action: 'edit_generator', generator: id, video_asks: g.video?.asks === false }, id, 'DGC didn\'t change it.'); });
        each('data-images-asks', id => { const g = gen(id); if (g) void simple(`asks:${id}`, { type: 'images_update', action: 'edit_generator', generator: id, asks: !g.asks }, id, 'DGC didn\'t change it.'); });
        each('data-images-remove', id => { S.removing = id; paint(); });
        each('data-images-remove-yes', id => { S.removing = ''; S.edits.delete(id); void simple(`remove:${id}`, { type: 'images_update', action: 'remove_generator', generator: id }, 'all', 'DGC didn\'t remove it.'); });
        root.querySelectorAll('[data-images-remove-no]').forEach(b => b.addEventListener('click', () => { S.removing = ''; paint(); }));
        root.querySelectorAll('[data-images-router]').forEach(b => b.addEventListener('click', () => document.getElementById('models-router')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })));
        root.querySelector('[data-images-plugins]')?.addEventListener('click', () => document.querySelector('[data-nav="plugins"]')?.click());
        root.querySelector('#images-project')?.addEventListener('change', e => void simple('project', { type: 'images_update', action: 'set_project_choice', generator: e.target.value }, 'all', 'DGC didn\'t change it.'));
        root.querySelector('[data-images-fallback]')?.addEventListener('click', () => void simple('fallback', { type: 'images_update', action: 'set_auto_fallback', auto_fallback: S.status?.auto_fallback !== true }, 'all', 'DGC didn\'t change it.'));
        const dir = root.querySelector('#images-save-dir');
        const saveDir = async () => {
            const value = String(dir?.value || '').trim();
            const reply = await simple('dir', { type: 'images_update', action: 'set_save_dir', save_dir: value }, 'dir', 'DGC didn\'t change it.');
            if (reply.ok) note('dir', reply.change || 'Saved.');
            paint();
        };
        root.querySelector('[data-images-save-dir]')?.addEventListener('click', () => void saveDir());
        dir?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); void saveDir(); } });
        // What is typed (and the paste box opened) is kept as it changes: the page is drawn again under an open form
        // whenever DGC says something new (a config, a refresh), and nothing typed may go with it.
        root.querySelectorAll('[data-images-adding] input, [data-images-adding] select, [data-images-adding] textarea')
            .forEach(box => box.addEventListener('input', () => readAdd()));
        root.querySelector('.images-paste')?.addEventListener('toggle', e => { if (S.adding) S.adding.pasteOpen = e.target.open; });
        root.querySelectorAll('[data-images-gen].editing input, [data-images-gen].editing select')
            .forEach(box => box.addEventListener('input', () => readEdit(box.closest('[data-images-gen]').dataset.imagesGen)));
        root.querySelectorAll('[data-edit="base_url"]').forEach(box => box.addEventListener('input', () => {
            const id = box.closest('[data-images-gen]')?.dataset.imagesGen, g = gen(id), warn = box.closest('label')?.querySelector('[data-images-moved]');
            if (g && warn) warn.hidden = !(box.value.trim() !== String(g.base_url || '') && g.key_from === 'saved');
        }));
    }

    // ---- drawing ----
    function paint(readAdding = true) {
        const root = page();
        // A section that isn't on screen (another page, an older CLI) has nothing to redraw.
        if (!root) { onPaint?.(); return; }
        if (readAdding) readAdd();
        for (const id of S.edits.keys()) readEdit(id);
        const active = document.activeElement, within = root.contains(active);
        const focus = within ? { id: active.id, attrs: [...active.attributes].filter(a => a.name.startsWith('data-')).map(a => [a.name, a.value]),
            card: active.closest('[data-images-gen]')?.dataset.imagesGen || '', start: active.selectionStart ?? null, end: active.selectionEnd ?? null } : null;
        const fresh = document.createElement('div');
        fresh.innerHTML = block();
        const next = fresh.firstElementChild;
        if (!next) { root.remove(); onPaint?.(); return; }
        root.replaceWith(next);
        bind(next);
        if (focus) {
            let el = focus.id ? next.querySelector('#' + CSS.escape(focus.id)) : null;
            if (!el && focus.attrs.length) {
                const scope = focus.card ? next.querySelector(`[data-images-gen="${CSS.escape(focus.card)}"]`) : next;
                el = scope?.querySelector(focus.attrs.map(([a, v]) => `[${a}="${CSS.escape(v)}"]`).join(''));
            }
            if (el && !el.disabled) {
                el.focus({ preventScroll: true });
                if (focus.start !== null && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(focus.start, focus.end); } catch { /* a number box */ } }
            }
        }
        onPaint?.();
    }
    return { state: S, receive, setCapability, block, bind, paint, shown, capable: () => S.capable, status: () => S.status };
}
