// Settings -> a Model box: a text field that lists the models at ITS card's own host, and still takes any name typed
// (a host that can't list, or a model it doesn't list). The host, transport and key it lists with are read from the
// card's fields as they are typed, never saved first; it lists again, after a pause, when any of them changes. The
// listing is DGC's (list_models_at, through the extension): a saved key only ever goes to the host it is bound to.

const CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';
const RELIST_MS = 600;
const SHOWN_MAX = 200;
const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The markup: the field's words on the left; the box, its open button and its list on the right. */
export function modelBoxMarkup(id, label, hint, value) {
    return `<div class="field model-field" data-model-field="${id}"><span class="words"><span class="name-line"><label class="name" for="${id}">${label}</label></span>`
        + `<span class="hint" id="${id}-hint"${hint ? '' : ' hidden'}>${hint}</span><span class="hint model-box-status" id="${id}-status" role="status" hidden></span></span>`
        + `<span class="model-box"><input id="${id}" type="text" value="${escape(value)}" autocomplete="off" spellcheck="false" role="combobox"`
        + ` aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-list" aria-describedby="${id}-hint ${id}-status">`
        + `<button type="button" class="model-box-open" tabindex="-1" data-model-open="${id}" aria-label="Show the models at this host" title="Show the models at this host">${CHEVRON}</button>`
        + `<ul class="model-box-list" id="${id}-list" role="listbox" aria-label="Models at this host" hidden></ul></span></div>`;
}

/** A short, one-way fingerprint of a typed key, so the cache can tell keys apart without keeping one. */
function fingerprint(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return text ? (h >>> 0).toString(36) : '';
}

/**
 * The page's Model boxes. `send` posts to the extension; `route(id)` answers what box `id` lists right now, as
 * typed: {role, base_url, api_mode, api_key} (api_key only when one is typed in the form), or null for nothing to
 * list yet. `fields(id)` names the inputs whose changes make it list again.
 */
export function createModelBoxes({ send, route, fields }) {
    const boxes = new Map();          // id -> {sig, token, state: 'idle'|'loading'|'ready'|'error', ids, error}
    const timers = new Map();
    let seq = 0;
    let main = null;

    const box = (id) => { if (!boxes.has(id)) boxes.set(id, { sig: '', token: '', state: 'idle', ids: [], error: '' }); return boxes.get(id); };
    const signature = (r) => r ? JSON.stringify([r.role, r.base_url, r.api_mode, fingerprint(r.api_key || '')]) : '';

    function list(id, force = false) {
        const b = box(id), r = route(id), sig = signature(r);
        if (!r) { Object.assign(b, { sig: '', token: '', state: 'idle', ids: [], error: '' }); paint(id); return; }
        if (!force && sig === b.sig && b.state !== 'error') { paint(id); return; }
        const token = `${id}-${++seq}`;
        Object.assign(b, { sig, token, state: 'loading', error: '' });
        paint(id);
        send({ type: 'listModelsAt', token, role: r.role, base_url: r.base_url, api_mode: r.api_mode, ...(r.api_key ? { api_key: r.api_key } : {}) });
    }
    function later(id) {
        clearTimeout(timers.get(id));
        timers.set(id, setTimeout(() => { timers.delete(id); list(id); }, RELIST_MS));
    }

    /** What the box says under its words: only when listing failed (a box that lists says nothing). */
    function paint(id) {
        if (!main) return;
        const b = box(id), status = main.querySelector(`#${id}-status`);
        if (status) {
            const text = b.state === 'error' ? `Couldn't list the models at this host: ${b.error}.` : '';
            status.textContent = text;
            status.hidden = !text;
        }
        const listbox = main.querySelector(`#${id}-list`);
        if (listbox && !listbox.hidden) fill(id);
    }

    function options(id) {
        const input = main.querySelector('#' + id), b = box(id);
        const typed = String(input?.value || '').trim().toLowerCase();
        const all = b.ids;
        // Opened on a name that is in the list (or empty): everything, so you can pick another. Typing filters.
        const filtering = input?.dataset.filter === '1' && typed && !all.some((m) => m.toLowerCase() === typed);
        return (filtering ? all.filter((m) => m.toLowerCase().includes(typed)) : all).slice(0, SHOWN_MAX);
    }

    function fill(id) {
        const listbox = main.querySelector(`#${id}-list`), input = main.querySelector('#' + id), b = box(id);
        if (!listbox || !input) return;
        const shown = options(id), current = String(input.value || '').trim();
        const note = (text) => `<li class="model-box-note" role="presentation">${escape(text)}</li>`;
        let html = shown.map((m, i) => `<li role="option" id="${id}-opt-${i}" data-model="${escape(m)}" aria-selected="${m === current}">${escape(m)}</li>`).join('');
        if (b.state === 'loading' && !shown.length) html = note('Listing the models at this host…');
        else if (b.state === 'error' && !shown.length) html = note("Couldn't list the models at this host. Type the model's name.");
        else if (b.state === 'idle' && !shown.length) html = note('Enter the host URL to list its models.');
        else if (!shown.length) html = note(b.ids.length ? 'No model here matches. Keep typing to use that name.' : 'This host lists no models. Type the model\'s name.');
        listbox.innerHTML = html;
        input.removeAttribute('aria-activedescendant');
        listbox.querySelectorAll('[role=option]').forEach((li) => {
            li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(id, li.dataset.model); });
        });
    }

    function open(id, filter) {
        const listbox = main.querySelector(`#${id}-list`), input = main.querySelector('#' + id);
        if (!listbox || !input || input.disabled) return;
        input.dataset.filter = filter ? '1' : '';
        listbox.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        fill(id);
        if (box(id).state === 'idle' || box(id).state === 'error') list(id, true);
        listbox.querySelector('[aria-selected=true]')?.scrollIntoView?.({ block: 'nearest' });
    }
    function close(id) {
        const listbox = main?.querySelector(`#${id}-list`), input = main?.querySelector('#' + id);
        if (listbox) listbox.hidden = true;
        if (input) { input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
    }
    function choose(id, model) {
        const input = main.querySelector('#' + id);
        if (!input) return;
        input.value = model;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        close(id);
        input.focus();
    }
    function move(id, step) {
        const listbox = main.querySelector(`#${id}-list`), input = main.querySelector('#' + id);
        const items = [...listbox.querySelectorAll('[role=option]')];
        if (!items.length) return;
        const at = items.findIndex((li) => li.id === input.getAttribute('aria-activedescendant'));
        const next = items[at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length];
        items.forEach((li) => li.classList.toggle('active', li === next));
        input.setAttribute('aria-activedescendant', next.id);
        next.scrollIntoView?.({ block: 'nearest' });
    }

    /** After every page render: wire the boxes on it, and list each one's host (from the cache when unchanged). */
    function bind(page) {
        main = page;
        for (const input of page.querySelectorAll('.model-box input[role=combobox]')) {
            const id = input.id;
            const listbox = page.querySelector(`#${id}-list`);
            page.querySelector(`[data-model-open="${id}"]`)?.addEventListener('mousedown', (e) => {
                e.preventDefault();
                if (listbox.hidden) { input.focus(); open(id, false); } else close(id);
            });
            input.addEventListener('input', () => { if (!listbox.hidden || input === document.activeElement) open(id, true); });
            input.addEventListener('keydown', (e) => {
                const shown = !listbox.hidden;
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (!shown) open(id, false);
                    move(id, e.key === 'ArrowDown' ? 1 : -1);
                } else if (e.key === 'Enter' && shown && input.getAttribute('aria-activedescendant')) {
                    e.preventDefault();
                    choose(id, page.querySelector('#' + input.getAttribute('aria-activedescendant'))?.dataset.model || input.value);
                } else if (e.key === 'Escape' && shown) {
                    e.preventDefault(); e.stopPropagation(); close(id);
                } else if (e.key === 'Tab') close(id);
            });
            input.addEventListener('blur', () => close(id));
            for (const fieldId of fields(id)) {
                const el = page.querySelector('#' + fieldId);
                el?.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => later(id));
            }
            list(id);
        }
    }

    /** The extension's answer to one listModelsAt. A box answers only its latest request. */
    function receive(msg) {
        for (const [id, b] of boxes) {
            if (b.token !== msg.token) continue;
            if (msg.unsupported) Object.assign(b, { state: 'error', ids: [], error: 'update the DGC CLI to list them here' });
            else if (msg.error) Object.assign(b, { state: 'error', ids: [], error: String(msg.error).replace(/\.$/, '') });
            else Object.assign(b, { state: 'ready', ids: Array.isArray(msg.ids) ? msg.ids.filter((m) => typeof m === 'string') : [], error: '' });
            paint(id);
        }
    }

    return { bind, receive, relist: (id) => later(id), state: (id) => ({ ...box(id) }) };
}
