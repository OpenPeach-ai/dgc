// Token usage by system: the System picker, the By system list and the system words on a model row, shared by the
// Everything and Pips views. All of it is built from the report's by_model rows: each row names the system it ran on
// (`system`, `system_id`, `system_kind`) on a DGC CLI with capabilities.usage_by_system. A range with one system, or
// an older CLI whose rows name none, shows no picker and no list, and the page reads as it always did.
export const systemPickerMarkup = '<label class="usage-system-pick" hidden>System <span class="set-hint">Where the requests ran.</span>'
  + '<select id="usage-system" aria-label="Show token usage for one system">'
  + '<option value="">All systems</option></select></label>';

const KIND_ORDER = { system: 0, computer: 1, service: 2 };
const count = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };

/** The systems the rows ran on, most tokens first: {id, name, kind, requests, unmetered, input, output, hosts}. */
export function systemsOf(rows) {
  const found = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.system_id || '').slice(0, 300);
    if (!id) continue;
    let entry = found.get(id);
    if (!entry) {
      const kind = ['system', 'computer', 'service'].includes(row.system_kind) ? row.system_kind : 'service';
      entry = { id, name: String(row.system || id).slice(0, 120), kind, requests: 0, unmetered: 0, input: 0, output: 0, hosts: new Set() };
      found.set(id, entry);
    }
    entry.requests += count(row.requests);
    entry.unmetered += count(row.unmetered_requests);
    entry.input += count(row.input_tokens);
    entry.output += count(row.output_tokens);
    if (row.host) entry.hosts.add(String(row.host).slice(0, 255));
  }
  return [...found.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output) || b.requests - a.requests
    || (KIND_ORDER[a.kind] ?? 3) - (KIND_ORDER[b.kind] ?? 3) || a.name.localeCompare(b.name));
}

/** All systems, then the computers (DGC Router systems first, then this computer), then the cloud services.
 *  Returns the value left selected: `selected` while it is among them, else "" (All systems). */
export function fillPicker(select, systems, selected) {
  const keep = systems.some((s) => s.id === selected) ? selected : '';
  select.replaceChildren(new Option('All systems', ''));
  const groups = [['Computers', systems.filter((s) => s.kind !== 'service').sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || a.name.localeCompare(b.name))],
    ['Cloud services', systems.filter((s) => s.kind === 'service').sort((a, b) => a.name.localeCompare(b.name))]];
  for (const [label, list] of groups) {
    if (!list.length) continue;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const s of list) group.appendChild(new Option(s.name, s.id));
    select.appendChild(group);
  }
  select.value = keep;
  return keep;
}

/** What a system is, in words: a DGC Router system, this computer, a computer on the network, a cloud service. */
export function kindWords(system) {
  if (system.kind === 'system') return 'DGC Router';
  if (system.id === 'computer:this') return 'this computer';
  return system.kind === 'computer' ? 'on your network' : 'cloud service';
}

/** The By system table: name (and what it is), input, output, requests (unmetered marked), share. Choosing a row
 *  shows that system alone. */
export function bySystemTable(systems, onPick, label = 'Token usage by system') {
  const wrap = node('div', 'usage-table-wrap usage-systems-wrap');
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', label);
  wrap.tabIndex = 0;
  const table = node('table', 'usage-table usage-systems');
  const head = node('thead'), tr = node('tr');
  const first = node('th', '', 'System');
  first.scope = 'col';
  first.appendChild(node('span', 'usage-th-sub', 'what it is'));
  tr.appendChild(first);
  for (const name of ['Input', 'Output', 'Requests']) { const th = node('th', 'num', name); th.scope = 'col'; tr.appendChild(th); }
  const shareHead = node('th', 'col-share', 'Share'); shareHead.scope = 'col'; tr.appendChild(shareHead);
  head.appendChild(tr);
  table.appendChild(head);
  const body = node('tbody');
  const whole = systems.reduce((sum, s) => sum + s.input + s.output, 0);
  const requests = systems.reduce((sum, s) => sum + s.requests, 0);
  for (const s of systems) {
    const row = node('tr');
    row.dataset.system = s.id;
    const cell = node('th', 'usage-model');
    cell.scope = 'row';
    const pick = node('button', 'usage-system-name link');
    pick.type = 'button';
    pick.textContent = s.name;
    pick.title = `Show ${s.name} alone`;
    pick.addEventListener('click', () => onPick(s.id));
    const nameLine = node('span', 'usage-clip usage-name');
    nameLine.appendChild(pick);
    const sub = node('span', 'usage-clip usage-where');
    const words = [kindWords(s)];
    if (s.unmetered) words.push(`${s.unmetered.toLocaleString()} unmetered`);
    sub.appendChild(node('span', 'usage-head', words.join(' · ')));
    const hosts = [...s.hosts].join(', ');
    cell.title = hosts && hosts !== s.name ? `${s.name}\n${hosts}` : s.name;
    cell.append(nameLine, sub);
    row.appendChild(cell);
    for (const value of [s.input, s.output]) row.appendChild(node('td', 'num', value.toLocaleString()));
    const asked = node('td', 'num', s.requests.toLocaleString());
    if (s.unmetered) asked.title = `${s.unmetered.toLocaleString()} of them reported no tokens (unmetered)`;
    row.appendChild(asked);
    const part = whole > 0 ? (s.input + s.output) / whole * 100 : requests > 0 ? s.requests / requests * 100 : 0;
    const text = part > 0 && part < 1 ? '<1%' : `${Math.round(part)}%`;
    const shareCell = node('td', 'usage-share-cell col-share'), share = node('span', 'usage-share'), track = node('span', 'usage-share-track');
    const fill = node('span', 'usage-share-fill' + (part > 0 ? ' nonzero' : ''));
    fill.style.width = `${Math.min(100, part)}%`;
    share.setAttribute('role', 'img');
    share.setAttribute('aria-label', `${text} of ${whole > 0 ? 'tokens' : 'requests'}`);
    track.appendChild(fill);
    share.append(track, node('span', 'usage-share-text', text));
    shareCell.appendChild(share);
    row.appendChild(shareCell);
    body.appendChild(row);
  }
  table.appendChild(body);
  wrap.appendChild(table);
  return wrap;
}

/** A model row's second line: "NAS · ollama" when systems are named, else null (the caller keeps "ollama ·
 *  nas.local:11434" as before). The address is one click away: the ⓘ button shows it on a line of its own under
 *  the row (and names it on hover). */
export function whereLine(row, named) {
  const provider = String(row.provider || '').slice(0, 64), host = String(row.host || '').slice(0, 255);
  const system = String(row.system || '').slice(0, 120);
  if (!named || !system) return null;
  const holder = node('span', 'usage-system-where-wrap');
  const line = node('span', 'usage-clip usage-where usage-system-where');
  line.appendChild(node('span', 'usage-head', [system, provider].filter(Boolean).join(' · ')));
  holder.appendChild(line);
  if (host && host !== system) {
    const info = node('button', 'usage-host-info', 'ⓘ');
    info.type = 'button';
    info.title = host;
    info.setAttribute('aria-label', `Address: ${host}`);
    info.setAttribute('aria-expanded', 'false');
    const address = node('span', 'usage-clip usage-where usage-host');
    address.appendChild(node('span', 'usage-head', host));
    address.hidden = true;
    info.addEventListener('click', (event) => {
      event.stopPropagation();
      address.hidden = !address.hidden;
      info.setAttribute('aria-expanded', String(!address.hidden));
    });
    line.appendChild(info);
    holder.appendChild(address);
  }
  return holder;
}
