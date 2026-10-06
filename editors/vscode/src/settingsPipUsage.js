// The Pips tab of Token usage: each Pip's share of the same range, from the runs that finished in
// it. A breakdown of the Everything totals, never an addition to them -- a Pip's requests are in the
// same ledger -- so the page says how much of everything the Pips used.
const RANGE = '<label>Range <span id="usage-timezone" class="set-hint">Days follow this computer&rsquo;s local time.</span>'
  + '<select id="usage-range"><option value="today">Today</option><option value="7d" selected>7 days</option><option value="30d">30 days</option>'
  + '<option value="month">This month</option><option value="all">All time</option></select></label>';
export const pipUsageMarkup = `<section class="set-section usage-section pip-usage-section" data-section="usage">${RANGE}
  <div class="usage-toolbar">
    <span id="pip-usage-status" class="usage-status" role="status" aria-live="polite"></span>
    <button type="button" id="pip-usage-refresh" class="fbtn usage-refresh" aria-label="Refresh token usage by Pip"><svg viewBox="0 0 21 21" aria-hidden="true"><path d="M14.74 6.26a6 6 0 1 1-4.24-1.76M8.5 2.5 10.5 4.5 8.5 6.5"/></svg><span>Refresh</span></button>
  </div>
  <div id="pip-usage-empty" class="usage-empty" hidden>
    <p class="usage-empty-title">No Pip runs finished in this range</p>
    <p>Each run a Pip finishes, scheduled, started by you or a reply in its chat, appears here with the tokens it used.</p>
  </div>
  <div id="pip-usage-content" hidden>
    <div id="pip-usage-figures" class="usage-figures"></div>
    <p id="pip-usage-part" class="set-note"></p>
    <div class="set-group">By Pip <span class="set-hint">sorted by total tokens</span></div>
    <div class="usage-table-wrap" role="region" aria-label="Token usage by Pip" tabindex="0">
      <table class="usage-table">
        <thead><tr><th scope="col">Pip <span class="usage-th-sub">kind &middot; where</span></th><th scope="col" class="num">Input</th><th scope="col" class="num">Output</th><th scope="col" class="num">Runs</th><th scope="col">Share</th></tr></thead>
        <tbody id="pip-usage-rows"></tbody>
      </table>
    </div>
    <p id="pip-usage-omitted" class="set-note" hidden></p>
    <div class="set-group">By model <span class="set-hint">what the Pips&rsquo; requests used, sorted by total tokens</span></div>
    <div class="usage-table-wrap" role="region" aria-label="Pip token usage by model" tabindex="0">
      <table class="usage-table">
        <thead><tr><th scope="col">Model <span class="usage-th-sub">provider &middot; host</span></th><th scope="col" class="num">Input</th><th scope="col" class="num">Output</th><th scope="col" class="num">Requests</th><th scope="col">Share</th></tr></thead>
        <tbody id="pip-usage-models"></tbody>
      </table>
    </div>
    <p id="pip-usage-models-empty" class="set-note" hidden>No model requests from the Pips were recorded in this range.</p>
  </div>
  <p class="set-note">A run counts on the day it finished, with the totals its runner recorded. Set a Pip&rsquo;s daily limit in its Job tab in Pips.</p>
</section>`;

export function createPipUsage(root, vscode) {
  const $ = id => root.querySelector('#' + id);
  const RANGES = ['today', '7d', '30d', 'month', 'all'];
  let requestId = '', sequence = 0, timer = 0;
  const count = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
  const exact = v => count(v).toLocaleString();
  const compact = v => {
    const n = count(v), scaled = (unit, suffix) => { const x = n / unit; return (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, '')) + suffix; };
    return n >= 1e9 ? scaled(1e9, 'B') : n >= 1e6 ? scaled(1e6, 'M') : n >= 1e4 ? scaled(1e3, 'K') : n.toLocaleString();
  };
  const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  const percent = (part, whole) => { const p = whole > 0 ? part / whole * 100 : 0; return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`; };
  function shareCell(part, whole, of) {
    const value = whole > 0 ? part / whole * 100 : 0, text = percent(part, whole);
    const cell = node('td', 'usage-share-cell'), wrap = node('span', 'usage-share'), track = node('span', 'usage-share-track');
    const fill = node('span', 'usage-share-fill' + (value > 0 ? ' nonzero' : ''));
    fill.style.width = `${Math.min(100, value)}%`;
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', `${text} of ${of}`);
    track.append(fill);
    wrap.append(track, node('span', 'usage-share-text', text));
    cell.append(wrap);
    return cell;
  }
  // A Pip's models in a few words: "glm-5.3:cloud · deepseek-v4.1-flash:cloud +1 more".
  function modelsLine(models) {
    const names = (Array.isArray(models) ? models : []).filter(m => m && typeof m === 'object').map(m => String(m.model || '').slice(0, 256)).filter(Boolean);
    if (!names.length) return '';
    return names.slice(0, 2).join(' · ') + (names.length > 2 ? ` +${names.length - 2} more` : '');
  }
  function status(text, busy) {
    $('pip-usage-status').textContent = text;
    if (busy) root.setAttribute('aria-busy', 'true'); else root.removeAttribute('aria-busy');
  }
  function request() {
    const range = RANGES.includes($('usage-range').value) ? $('usage-range').value : '7d';
    requestId = `pip-usage-${Date.now().toString(36)}-${++sequence}`;
    const asked = requestId;
    status('Counting…', true);
    clearTimeout(timer);
    timer = setTimeout(() => { if (asked === requestId) status('No answer from the DGC backend yet. Try Refresh.', false); }, 15000);
    vscode.postMessage({ type: 'getPipUsage', range, requestId });
  }
  function unavailable(msg) {
    if (msg.requestId && msg.requestId !== requestId) return;
    clearTimeout(timer);
    $('pip-usage-content').hidden = true;
    $('pip-usage-empty').hidden = true;
    status(String(msg.message || 'Token usage by Pip is unavailable.').slice(0, 300), false);
  }
  function receive(ev) {
    if (!ev || ev.request_id !== requestId) return;      // a late answer to an older request
    clearTimeout(timer);
    const zone = String(ev.timezone || '').slice(0, 64);
    $('usage-timezone').textContent = `Days follow this computer’s local time${zone ? ` (${zone})` : ''}.`;
    const pips = (Array.isArray(ev.by_pip) ? ev.by_pip : []).filter(p => p && typeof p === 'object').slice(0, 200);
    if (ev.error && !pips.length) {
      $('pip-usage-content').hidden = true;
      $('pip-usage-empty').hidden = true;
      status(`Token usage by Pip could not be read: ${String(ev.error).slice(0, 300)}`, false);
      return;
    }
    const stamp = new Date(String(ev.generated_at || ''));
    status(Number.isNaN(stamp.getTime()) ? 'Updated just now' : `Updated ${stamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, false);
    $('pip-usage-empty').hidden = pips.length > 0;
    $('pip-usage-content').hidden = !pips.length;
    if (!pips.length) return;
    const totals = ev.totals && typeof ev.totals === 'object' ? ev.totals : {};
    const tokensOf = p => count(p.input_tokens) + count(p.output_tokens);
    const pipTokens = count(totals.input_tokens) + count(totals.output_tokens), all = count(ev.all_tokens);
    const figures = $('pip-usage-figures');
    figures.replaceChildren();
    for (const [label, value, unit] of [['Pip tokens', pipTokens, 'tokens'], ['Runs', count(totals.runs), 'runs'], ['Pips', pips.length, 'Pips']]) {
      const figure = node('div', 'usage-figure');
      figure.setAttribute('role', 'group');
      figure.setAttribute('aria-label', `${label}: ${exact(value)} ${unit}`);
      figure.append(node('span', 'usage-figure-label', label), node('span', 'usage-figure-value', compact(value)));
      if (compact(value) !== exact(value)) figure.append(node('span', 'usage-figure-exact', `${exact(value)} ${unit}`));
      figures.append(figure);
    }
    $('pip-usage-part').textContent = all > 0
      ? `Pips used ${percent(pipTokens, all)} of the ${exact(all)} tokens counted in this range. That is part of the Everything total, not added to it, and includes replies in each Pip’s chat.`
      : 'That is part of the Everything total, not added to it, and includes replies in each Pip’s chat.';
    const body = $('pip-usage-rows');
    body.replaceChildren();
    for (const p of pips) {
      const tr = node('tr');
      const name = node('th', 'usage-model');
      name.setAttribute('scope', 'row');
      const where = p.scope === 'personal' ? 'Personal' : String(p.project || 'project').slice(0, 120);
      const notes = [p.status === 'paused' ? 'paused' : p.status === 'archived' ? 'archived' : p.status === 'removed' ? 'removed' : '',
        Number.isSafeInteger(p.daily_cap) ? `limit ${compact(p.daily_cap)}/day` : ''].filter(Boolean).join(' · ');
      const line = node('span', 'usage-clip usage-name');
      line.append(node('span', 'usage-head', String(p.name || 'Pip').slice(0, 120)));
      const sub = node('span', 'usage-clip usage-where');
      sub.append(node('span', 'usage-head', [String(p.pip_type || '').slice(0, 16), where, notes].filter(Boolean).join(' · ')));
      const used = modelsLine(p.models);
      name.title = `${String(p.name || 'Pip').slice(0, 120)}\n${sub.textContent}${used ? `\n${used}` : ''}`;
      name.append(line, sub);
      if (used) { const models = node('span', 'usage-clip usage-where usage-pip-models'); models.append(node('span', 'usage-head', used)); name.append(models); }
      tr.append(name, node('td', 'num', exact(p.input_tokens)), node('td', 'num', exact(p.output_tokens)), node('td', 'num', exact(p.runs)));
      tr.append(shareCell(tokensOf(p), pipTokens, 'Pip tokens'));
      body.append(tr);
    }
    // The Pips' requests by model, from the ledger: the range's whole story, older runs included.
    const models = (Array.isArray(ev.by_model) ? ev.by_model : []).filter(m => m && typeof m === 'object').slice(0, 100);
    const modelTokens = models.reduce((sum, m) => sum + tokensOf(m), 0);
    const modelRows = $('pip-usage-models');
    modelRows.replaceChildren();
    for (const m of models) {
      const tr = node('tr'), cell = node('th', 'usage-model');
      cell.setAttribute('scope', 'row');
      const model = String(m.model || 'unknown').slice(0, 256), where = [String(m.provider || '').slice(0, 64), String(m.host || '').slice(0, 255)].filter(Boolean).join(' · ');
      cell.title = where ? `${model}\n${where}` : model;
      const first = node('span', 'usage-clip usage-name'), second = node('span', 'usage-clip usage-where');
      first.append(node('span', 'usage-head', model)); second.append(node('span', 'usage-head', where || '—'));
      cell.append(first, second);
      tr.append(cell, node('td', 'num', exact(m.input_tokens)), node('td', 'num', exact(m.output_tokens)), node('td', 'num', exact(m.requests)),
        shareCell(tokensOf(m), modelTokens, 'Pip tokens by model'));
      modelRows.append(tr);
    }
    $('pip-usage-models-empty').hidden = models.length > 0;
    const omitted = count(ev.omitted);
    $('pip-usage-omitted').hidden = omitted === 0;
    $('pip-usage-omitted').textContent = omitted ? `${omitted.toLocaleString()} more Pip${omitted === 1 ? '' : 's'} with fewer tokens are not listed.` : '';
  }
  $('usage-range').onchange = request;
  $('pip-usage-refresh').onclick = request;
  return { request, receive, unavailable, dispose() { clearTimeout(timer); } };
}
