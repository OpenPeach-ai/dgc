// pips-09: Settings → MCP servers → Add server, "paste a link or a `claude mcp add` command and it fills in the rest".
// What a person pastes, read into the Add server form's fields (name, how it connects, URL or command, arguments,
// environment, token). Nothing is saved or run here: the form shows what was read, and Save and connect tests it.
// Read: a server URL; `claude mcp add [options] <name> <url|command> [args...]` (options --transport/-t, --env/-e,
// --header/-H, --scope/-s, and `--` before a command); `claude mcp add-json <name> '<json>'`; and the JSON other apps
// share ({"mcpServers": {"name": {...}}}, or one server's {...}).

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX = 20000;

/** Words of a pasted command, as a shell splits them: quotes kept together, backslash-newlines joined. */
export function words(text) {
  const out = [];
  let word = '', quote = '', started = false;
  const src = String(text).replace(/\\\r?\n/g, ' ');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) { quote = ''; continue; }
      if (c === '\\' && quote === '"' && i + 1 < src.length && '"\\$`'.includes(src[i + 1])) { word += src[++i]; continue; }
      word += c; continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === '\\' && i + 1 < src.length) { word += src[++i]; started = true; continue; }
    if (/\s/.test(c)) { if (started || word) out.push(word); word = ''; started = false; continue; }
    word += c; started = true;
  }
  if (quote) throw new Error('A quote in what you pasted is never closed.');
  if (started || word) out.push(word);
  return out;
}

/** A short name from a server's address: mcp.notion.com → notion. */
export function nameFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().split('.').filter((p) => p && !['mcp', 'www', 'api', 'app', 'server'].includes(p));
    const pick = host.length >= 2 ? host[host.length - 2] : host[0] || 'server';
    return pick.replace(/[^a-z0-9_.-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64) || 'server';
  } catch { return 'server'; }
}

const isUrl = (value) => /^https?:\/\/[^\s]+$/i.test(value);

function tokenFrom(headers) {
  // Only a bearer token has a field to go to; any other header is said, not kept.
  let token = '';
  const other = [];
  for (const header of headers) {
    const m = /^\s*authorization\s*:\s*bearer\s+(\S+)\s*$/i.exec(header);
    if (m) token = m[1];
    else if (header.trim()) other.push(header.split(':')[0].trim());
  }
  return { token, other };
}

function fromJson(name, spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('That JSON has no server in it.');
  const url = spec.url || spec.serverUrl || spec.httpUrl;
  const headers = spec.headers && typeof spec.headers === 'object' ? Object.entries(spec.headers).map(([k, v]) => `${k}: ${v}`) : [];
  const { token, other } = tokenFrom(headers);
  const env = spec.env && typeof spec.env === 'object' ? Object.entries(spec.env).map(([k, v]) => `${k}=${v}`) : [];
  if (typeof url === 'string' && isUrl(url)) {
    return done({ name: name || nameFromUrl(url), transport: 'remote', target: url, args: [], env: [], token, other });
  }
  if (typeof spec.command === 'string' && spec.command) {
    const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
    return done({ name: name || spec.command.split('/').pop(), transport: 'stdio', target: spec.command, args, env, token: '', other });
  }
  throw new Error('That JSON names neither a URL nor a command.');
}

function done({ other = [], ...found }) {
  const name = String(found.name || '').replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
  return { ...found, name: NAME.test(name) ? name : 'server',
           ...(other.length ? { note: `DGC keeps only a bearer token; ${other.join(', ')} ${other.length === 1 ? 'was' : 'were'} left out.` } : {}) };
}

/** {name, transport: 'remote'|'stdio', target, args, env (NAME=value lines), token, note?}; throws Error with plain words. */
export function parseMcpPaste(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('Paste a server URL or a claude mcp add command.');
  if (raw.length > MAX) throw new Error('That is too long to be a server address or command.');
  if (isUrl(raw)) return done({ name: nameFromUrl(raw), transport: 'remote', target: raw, args: [], env: [], token: '' });
  if (raw.startsWith('{')) {
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error('That looks like JSON but it couldn\'t be read.'); }
    const servers = value.mcpServers || value.servers || value['mcp.servers'];
    if (servers && typeof servers === 'object') {
      const [name, spec] = Object.entries(servers)[0] || [];
      return fromJson(name, spec);
    }
    return fromJson('', value);
  }
  const w = words(raw);
  if (w[0] === 'claude' && w[1] === 'mcp' && w[2] === 'add-json') {
    if (w.length < 5) throw new Error('claude mcp add-json needs a name and the server\'s JSON.');
    let spec;
    try { spec = JSON.parse(w[4]); } catch { throw new Error('The server\'s JSON couldn\'t be read.'); }
    return fromJson(w[3], spec);
  }
  if (!(w[0] === 'claude' && w[1] === 'mcp' && w[2] === 'add')) {
    throw new Error('Paste a server URL, a claude mcp add command, or a server\'s JSON.');
  }
  let transport = '', i = 3;
  const env = [], headers = [], rest = [];
  for (; i < w.length; i++) {
    const a = w[i];
    if (a === '--') { rest.push(...w.slice(i + 1)); break; }
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const take = () => (inline !== undefined ? inline : w[++i]);
    if (flag === '--transport' || flag === '-t') { transport = String(take() || '').toLowerCase(); continue; }
    if (flag === '--env' || flag === '-e') { const v = take(); if (v) env.push(v); continue; }
    if (flag === '--header' || flag === '-H') { const v = take(); if (v) headers.push(v); continue; }
    if (flag === '--scope' || flag === '-s') { take(); continue; }
    if (flag.startsWith('-') && rest.length < 1) throw new Error(`DGC doesn't know ${flag} in a claude mcp add command.`);
    rest.push(a);
  }
  const [name, target, ...args] = rest;
  if (!name) throw new Error('The command names no server.');
  if (!target) throw new Error('The command has no URL or command for the server.');
  const { token, other } = tokenFrom(headers);
  if (isUrl(target) && transport !== 'stdio') {
    return done({ name, transport: 'remote', target, args: [], env: [], token, other });
  }
  if (transport === 'http' || transport === 'sse') throw new Error(`An ${transport} server needs a URL.`);
  return done({ name, transport: 'stdio', target, args, env, token: '', other });
}
