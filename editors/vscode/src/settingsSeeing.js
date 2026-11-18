// Settings -> Models -> "A model that can see" (dgc/seeing.py, ready.capabilities.seeing): when a chat's model can't see a
// picture, what every chat starts from -- ask when needed, a model that can see on one of your connections, or work
// without seeing -- in Work, ChatDGC and your Pips. A session, a chat or a Pip that answered its card keeps that answer
// until you choose here again: the newer word counts. One row; it saves as it changes, apart from Save all.
// The list is DGC's own search (every connection you added, the chat's own first), by name: never an address or a key.

/** The select's value for a choice: "ask", "off", or "relay|<kind>|<id>|<model>". */
export function choiceValue(choice) {
    if (!choice || choice.choice !== 'relay' || !choice.model || !choice.connection) return choice?.choice === 'off' ? 'off' : 'ask';
    const c = choice.connection;
    return ['relay', c.kind || '', c.id || '', choice.model].join('|');
}

/** The rows the select offers: Ask when needed, each model that can see (on its connection), Work without seeing. A
 *  remembered model that wasn't found this time stays listed, so the select never shows a choice it doesn't have. */
export function seeingOptions(models, choice) {
    const rows = [['ask', 'Ask when needed']];
    const seen = new Set();
    for (const m of Array.isArray(models) ? models : []) {
        if (!m || typeof m.model !== 'string' || !m.connection) continue;
        const value = choiceValue({ choice: 'relay', model: m.model, connection: m.connection });
        if (seen.has(value)) continue;
        seen.add(value);
        rows.push([value, `Use ${m.model} to see${m.connection.name ? ` · ${m.connection.name}` : ''}`]);
    }
    const current = choiceValue(choice);
    if (current.startsWith('relay|') && !seen.has(current))
        rows.push([current, `Use ${choice.model} to see${choice.connection?.name ? ` · ${choice.connection.name}` : ''}`]);
    rows.push(['off', 'Work without seeing']);
    return rows;
}

/** The choice a select value stands for, with the model's connection as DGC listed it. */
export function choiceOf(value, models, choice) {
    if (value === 'ask' || value === 'off') return { choice: value };
    const all = [...(Array.isArray(models) ? models : []), ...(choice?.choice === 'relay' ? [choice] : [])];
    const hit = all.find(m => m && m.connection && choiceValue({ choice: 'relay', model: m.model, connection: m.connection }) === value);
    return hit ? { choice: 'relay', model: hit.model, connection: { ...hit.connection } } : null;
}

export function createSeeing({ send, esc, ui, onPaint }) {
    const S = { capable: false, choice: null, models: null, error: '', note: '', busy: false, seq: 0, waiting: new Map(), asked: 0 };
    const page = () => document.getElementById('models-seeing');

    function command(cmd) {
        const token = `seeing-${++S.seq}`;
        return new Promise(resolve => { S.waiting.set(token, resolve); send({ type: 'seeingCommand', token, ...cmd }); });
    }
    function receive(msg) {
        if (msg.type !== 'seeingReply') return false;
        const done = S.waiting.get(msg.token);
        S.waiting.delete(msg.token);
        if (typeof done === 'function') done(msg);
        return true;
    }
    async function refresh() {
        S.asked = Date.now();
        S.busy = true;
        paint();
        const reply = await command({ op: 'list' });
        S.busy = false;
        if (reply.ok) { S.choice = reply.choice || { choice: 'ask' }; S.models = Array.isArray(reply.models) ? reply.models : []; S.error = reply.error || ''; }
        else S.error = reply.error || 'DGC didn\'t answer.';
        paint();
    }
    async function choose(value) {
        const picked = choiceOf(value, S.models, S.choice);
        if (!picked) return;
        S.busy = true; S.note = '';
        paint();
        const reply = await command({ op: 'set', ...picked });
        S.busy = false;
        if (reply.ok) {
            S.choice = reply.choice || picked;
            S.note = picked.choice === 'relay' ? `${picked.model} looks at pictures for every chat whose model can't see, from now on.`
                : picked.choice === 'off' ? 'Chats whose model can\'t see work without seeing, from now on.'
                : 'A chat whose model can\'t see asks you the first time it gets a picture.';
            if (reply.note) S.note += ` ${reply.note}`;
            S.error = '';
        } else S.error = reply.error || 'DGC didn\'t save it.';
        paint();
    }
    function setCapability(config) {
        const was = S.capable;
        S.capable = config?.seeing_capable === true;
        if (S.capable && !was) void refresh();
    }
    /** Models is on screen again: search again unless it was a moment ago. */
    function shown() {
        if (S.capable && !S.busy && Date.now() - S.asked > 5000) void refresh();
    }
    function block() {
        if (!S.capable) return '';
        const ready = Array.isArray(S.models);
        const rows = seeingOptions(S.models || [], S.choice);
        const value = choiceValue(S.choice);
        const select = `<select id="seeing_choice" aria-label="A model that can see" aria-describedby="seeing-says"${S.busy || !ready ? ' disabled' : ''}>`
            + rows.map(([v, words]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(words)}</option>`).join('') + '</select>';
        const found = ready && !S.models.length ? 'None of your connections has a model that can see.' : '';
        const hint = !ready ? 'Looking for models that can see…' : 'When a chat\'s model can\'t see a picture.';
        const more = 'Work, ChatDGC and your Pips. Ask when needed: the first picture asks, with three choices, and the answer is that session\'s, chat\'s or Pip\'s. A model here: no question, it looks and says so. A session, chat or Pip keeps its own answer until you choose here again.';
        return '<section class="group" id="models-seeing" data-block="seeing"><h3>A model that can see</h3>'
            + ui.field('When a model can\'t see', hint, select, more)
            + (found ? `<p class="router-note" role="status">${esc(found)}</p>` : '')
            + (S.error ? `<p class="router-note error" role="alert" id="seeing-says">${esc(S.error)}</p>`
                : S.note ? `<p class="router-note" role="status" id="seeing-says">${esc(S.note)}</p>` : '')
            + '</section>';
    }
    function bind(root) {
        root?.querySelector?.('#seeing_choice')?.addEventListener('change', (event) => { event.stopPropagation(); void choose(event.target.value); });
        root?.querySelector?.('#seeing_choice')?.addEventListener('input', (event) => event.stopPropagation());
    }
    function paint() {
        const root = page();
        if (!root) { onPaint?.(); return; }
        const had = document.activeElement?.id === 'seeing_choice';
        const holder = document.createElement('div');
        holder.innerHTML = block();
        const next = holder.firstElementChild;
        if (!next) return;
        root.replaceWith(next);
        bind(next);
        if (had) document.getElementById('seeing_choice')?.focus?.();
        onPaint?.();
    }
    return { state: S, receive, setCapability, block, bind, paint, shown, capable: () => S.capable };
}
