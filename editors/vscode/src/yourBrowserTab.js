// A Pip's tab in Your Browser, streamed into an editor tab beside the chat (Pips API 107; his call, 17 Nov). Your Browser
// is Google Chrome with DGC's own profile, a real window to the right of the editor; each Pip works in its own tab of it
// (its lane). This page shows ONE Pip's lane live, with DGC's own address bar and a row of the Pips' tabs, and it stands
// in where the window can't be seen. The person's own tabs are never shown here: DGC streams only a Pip's lane.
//
// The tab talks to the extension host as the Pips view does (pipsRequest / pipsReply); the host pins it to this one Pip
// and to use_your_browser_view and open_your_browser (src/pipsView.ts yourBrowserTabRefusal). A frame is asked about
// three times a second while the tab is visible (DGC gives at most four); a click, typing, a key or the wheel on the
// picture is the person's own hand in that Pip's tab, and Back, Forward, Reload and the address bar drive it. An address
// off the sites the person let that Pip use is refused by DGC, in words.
//
// Your own tab (his call, 18 Nov; `yourBrowserInit {own: true}`): where the computer DGC runs on has no screen
// (Remote-SSH), Google Chrome runs headless there and this tab IS Your Browser: your own current tab, streamed at every
// frame (one asked for as soon as the last came, up to thirty a second; none while the tab is hidden), and usable: clicks,
// typing (passwords included), keys, the wheel and a paste of the editor's clipboard go to it, in order. Our own address
// bar (an address, else a Google search), Back, Forward, Reload, and your tabs as a row with New tab and Close. One quiet
// line says what can't work here. Only this tab's own events drive it (the host lets no other page ask for your tab, and
// DGC lets no Pip, model or tool); its pictures stay in this tab.
import '../media/shared/tokens.css';
import '../media/shared/dismiss.css';   // one × for every line that stays (window.DgcDismiss)
import '../media/shared/dismiss.js';
import './yourBrowserTab.css';

const vscode = acquireVsCodeApi();
const API = 107, POLL_MS = 330;
const S = { pip: null, own: false, generation: 0, connected: false, api: 0, frame: null, lanes: [], tabs: [], current: '', note: '', typing: false, busy: false, seq: 0, pending: new Map(), shown: 0, frameSeq: 0, last: 0 };
const OWN_LINE = 'Passkeys, security keys and your computer’s password manager don’t work in this tab.';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (d) => `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const BACK = svg('<path d="M9.5 3.5 5 8l4.5 4.5"/>'), FORWARD = svg('<path d="M6.5 3.5 11 8l-4.5 4.5"/>'), RELOAD = svg('<path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2"/><path d="M12.5 3v2.6H9.9"/>');
const WINDOW = svg('<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><path d="M2.5 6h11"/>');
const PLUS = svg('<path d="M8 3.5v9M3.5 8h9"/>'), CROSS = svg('<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>');
const GLOBE = svg('<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.6 1.7 2.4 3.5 2.4 5.5S9.6 11.8 8 13.5M8 2.5C6.4 4.2 5.6 6 5.6 8s.8 3.8 2.4 5.5"/>');

const app = document.getElementById('app');
app.innerHTML = `<header class="yb-bar">
  <div class="yb-tabs" role="tablist" aria-label="The Pips' tabs in Your Browser"></div>
  <div class="yb-row">
    <button type="button" class="yb-btn yb-back" title="Back" aria-label="Back">${BACK}</button>
    <button type="button" class="yb-btn yb-forward" title="Forward" aria-label="Forward">${FORWARD}</button>
    <button type="button" class="yb-btn yb-reload" title="Reload" aria-label="Reload">${RELOAD}</button>
    <form class="yb-address" role="search"><input class="yb-url" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="2000" enterkeyhint="go" aria-label="This Pip's tab: an address or a search, then Enter"></form>
    <button type="button" class="yb-btn yb-window" title="Show this tab in Your Browser's window" aria-label="Show this tab in Your Browser's window">${WINDOW}</button>
  </div>
</header>
<p class="yb-line" hidden></p>
<div class="yb-stage"><img class="yb-frame" tabindex="0" alt="" hidden draggable="false"><textarea class="yb-keys" aria-label="What you type goes to your tab" autocomplete="off" autocapitalize="off" spellcheck="false" hidden></textarea><p class="yb-note" role="status"></p></div>`;
const $ = (sel) => app.querySelector(sel);
const tabs = $('.yb-tabs'), url = $('.yb-url'), frame = $('.yb-frame'), note = $('.yb-note'), line = $('.yb-line'), keys = $('.yb-keys'), stage = $('.yb-stage');

function ask(type, fields = {}) {
  return new Promise((resolve, reject) => {
    const id = `yb-${S.generation}-${++S.seq}`;
    const timer = setTimeout(() => { S.pending.delete(id); reject(new Error('DGC didn’t answer.')); }, 20000);
    S.pending.set(id, { resolve, reject, timer });
    vscode.postMessage({ type: 'pipsRequest', id, generation: S.generation, request: S.own ? { type, own: true, ...fields } : { type, pip_id: S.pip?.id, ...fields } });
  });
}
const ready = () => (S.own || !!S.pip) && S.connected && S.api >= API;

// The note is written only when its words change: it keeps its × (and stays closed) between two pictures.
function sayNote() { if (note.dataset.said !== S.note) { note.dataset.said = S.note; note.textContent = S.note; } note.hidden = !S.note; }
function paint() {
  if (S.own) { paintOwn(); return; }
  document.title = S.pip ? `${S.pip.name} · Your Browser` : 'Your Browser';
  const f = S.frame;
  frame.hidden = !f;
  if (f && frame.dataset.src !== f.image) { frame.dataset.src = f.image; frame.src = f.image; }
  frame.alt = f ? `${S.pip?.name || 'The Pip'}'s tab: ${f.title || f.url}` : '';
  if (f && !S.typing && document.activeElement !== url) url.value = f.url || '';
  url.placeholder = S.pip ? `${S.pip.name}'s tab: an address or a search` : '';
  sayNote();
  // The Pips' tabs: this Pip's first and chosen; another opens its own editor tab.
  const lanes = S.lanes.length ? S.lanes : S.pip ? [{ pip_id: S.pip.id, name: S.pip.name, title: f?.title || '' }] : [];
  const html = lanes.map((l) => `<button type="button" role="tab" class="yb-tab" data-pip="${esc(l.pip_id)}" data-name="${esc(l.name || '')}" aria-selected="${l.pip_id === S.pip?.id}" title="${esc(`${l.name || 'A Pip'}: ${l.title || l.url || ''}`)}"><span class="yb-tab-name">${esc(l.name || 'A Pip')}</span>${l.title ? `<span class="yb-tab-title">${esc(l.title)}</span>` : ''}</button>`).join('');
  if (tabs.__html !== html) { tabs.__html = html; tabs.innerHTML = html; }
  for (const b of app.querySelectorAll('.yb-btn')) b.disabled = !ready() || !f;
}

// ---- your own tab ---------------------------------------------------------------------------------------------------
function paintOwn() {
  const f = S.frame, current = S.tabs.find((t) => t.current) || null;
  document.title = 'Your Browser';
  frame.hidden = !f;
  if (f && frame.dataset.seq !== String(S.frameSeq)) { frame.dataset.seq = String(S.frameSeq); frame.src = f.image; }
  frame.alt = f ? `Your tab: ${f.title || f.url}` : '';
  if (!S.typing && document.activeElement !== url) url.value = f?.url || current?.url || '';
  url.placeholder = 'Search Google or type an address';
  url.setAttribute('aria-label', 'Your tab: an address or a search, then Enter');
  sayNote();
  if (line.textContent !== OWN_LINE) line.textContent = OWN_LINE;
  line.hidden = false;
  keys.hidden = false;
  $('.yb-window').hidden = true;
  app.classList.add('yb-own-mode');
  tabs.setAttribute('aria-label', 'Your tabs');
  const html = S.tabs.map((t) => { const name = t.title || t.url || 'New tab';
    // Like Chrome's: the site's icon (a globe until DGC has it), the title, its Close.
    const mark = t.icon ? `<img class="yb-fav" src="${esc(t.icon)}" alt="" aria-hidden="true">` : `<span class="yb-fav yb-fav-none" aria-hidden="true">${GLOBE}</span>`;
    return `<div class="yb-own${t.current ? ' yb-on' : ''}"><button type="button" role="tab" class="yb-tab" data-tab="${esc(t.id)}" aria-selected="${t.current}" title="${esc(`${name}${t.url && t.url !== name ? ` · ${t.url}` : ''}`)}">${mark}<span class="yb-tab-title">${esc(name)}</span></button>`
      + `<button type="button" class="yb-x" data-close="${esc(t.id)}" title="Close tab" aria-label="${esc(`Close ${name}`)}">${CROSS}</button></div>`; }).join('')
    + `<button type="button" class="yb-btn yb-new" title="New tab" aria-label="New tab"${ready() ? '' : ' disabled'}>${PLUS}</button>`;
  if (tabs.__html !== html) { tabs.__html = html; tabs.innerHTML = html; }
  liftIcons();
  for (const b of app.querySelectorAll('.yb-row .yb-btn')) b.disabled = !ready() || !f;
}
/** Whether the editor around this tab is dark (its own background, as drawn). */
function darkEditor() {
  const m = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g);
  if (!m || m.length < 3) return false;
  const [r, g, b] = m.slice(0, 3).map((v) => Number(v) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.4;
}
/** A site icon that is dark and of one colour (black, near-black, grey), by its own pixels: on a dark editor it is drawn
 *  light, as the site's dark-mode icon would be. Coloured icons are left as they are. */
const iconTones = new Map();
function darkOneColour(img) {
  const key = img.currentSrc || img.src;
  if (iconTones.has(key)) return iconTones.get(key);
  let tone = false;
  try {
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    let n = 0, lum = 0, spread = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const r = d[i] / 255, gr = d[i + 1] / 255, b = d[i + 2] / 255;
      lum += 0.2126 * r + 0.7152 * gr + 0.0722 * b; spread += Math.max(r, gr, b) - Math.min(r, gr, b); n += 1;
    }
    tone = n > 8 && lum / n < 0.22 && spread / n < 0.15;
  } catch { tone = false; }
  if (iconTones.size > 300) iconTones.clear();
  iconTones.set(key, tone);
  return tone;
}
function liftIcons() {
  const dark = darkEditor();
  app.classList.toggle('yb-dark', dark);
  for (const img of tabs.querySelectorAll('img.yb-fav')) {
    const apply = () => img.classList.toggle('yb-fav-lift', dark && darkOneColour(img));
    if (img.complete && img.naturalWidth) apply(); else img.addEventListener('load', apply, { once: true });
  }
}
function tookOwn(said) {
  if (!said || typeof said !== 'object') return;
  if (Array.isArray(said.tabs)) S.tabs = said.tabs.filter((t) => t && typeof t.id === 'string').slice(0, 50).map((t) => ({ id: t.id, title: String(t.title || ''), url: String(t.url || ''), current: t.current === true,
    icon: typeof t.icon === 'string' && /^data:image\/(png|x-icon|svg\+xml|gif|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(t.icon) && t.icon.length < 140000 ? t.icon : '' }));
  if (typeof said.current === 'string') S.current = said.current;
  if (said.ok && typeof said.image === 'string' && said.image.startsWith('data:image/jpeg;base64,')) {
    S.frame = { image: said.image, url: String(said.url || ''), title: String(said.title || ''), width: Number(said.width) || 0, height: Number(said.height) || 0 };
    S.shown += 1; S.frameSeq += 1;
  } else if (S.frame && said.ok) {
    S.frame = { ...S.frame, url: String(said.url ?? S.frame.url), title: String(said.title ?? S.frame.title), width: Number(said.width) || S.frame.width, height: Number(said.height) || S.frame.height };
  }
  // (DGC's own frame number: never the page's request counter, S.seq, whose ids must stay unique.)
  if (Number.isSafeInteger(said.seq) && said.seq >= 0) S.last = said.seq;
  S.note = said.ok === false ? String(said.error || 'Your Browser didn’t answer.') : '';
  if (said.closed) S.frame = null;
  paint();
}
// One frame asked for as soon as the last came (DGC waits a moment for a newer one): up to thirty a second, none hidden.
let streaming = false;
async function streamOwn() {
  if (streaming) return;
  streaming = true;
  try {
    while (ready() && S.own && !document.hidden) {
      try { tookOwn(await ask('use_your_browser_view', { op: 'frame', seq: S.last })); }
      catch (error) { S.note = String(error?.message || 'No picture yet.'); paint(); await new Promise((r) => setTimeout(r, 600)); }
    }
  } finally { streaming = false; }
}
// Your own hand in your tab: events in order, one input at a time (a move or the wheel folded into the last one).
const queue = [];
let sending = false;
function push(event) {
  if (!ready() || !S.own) return;
  const last = queue[queue.length - 1];
  if (last && event.t === 'move' && last.t === 'move') queue[queue.length - 1] = event;
  else if (last && event.t === 'wheel' && last.t === 'wheel') { last.dx = (last.dx || 0) + (event.dx || 0); last.dy = (last.dy || 0) + (event.dy || 0); }
  else queue.push(event);
  void sendInput();
}
async function sendInput() {
  if (sending || !queue.length) return;
  sending = true;
  try {
    while (queue.length) {
      const events = queue.splice(0, 20);
      try { tookOwn(await ask('use_your_browser_view', { op: 'input', events })); }
      catch (error) { S.note = String(error?.message || 'That didn’t reach your tab.'); paint(); }
    }
  } finally { sending = false; }
}
/** Your page's selected text onto this editor's clipboard (Copy, Cut in your tab). */
async function copyOut() {
  if (!ready()) return;
  try {
    const got = await ask('use_your_browser_view', { op: 'selection' });
    const text = typeof got?.text === 'string' ? got.text : '';
    if (!text) return;
    try { await navigator.clipboard.writeText(text); }
    catch { keys.value = text; keys.select(); document.execCommand('copy'); keys.value = ''; }
  } catch { /* the key still goes to the page */ }
}
async function actOwn(op, fields = {}) {
  if (!ready()) return;
  try { tookOwn(await ask('use_your_browser_view', { op, ...fields })); }
  catch (error) { S.note = String(error?.message || 'Your Browser didn’t answer.'); paint(); }
}
const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
/** Where a pointer is on your page, in the page's own pixels. */
function at(e) {
  const f = S.frame, r = frame.getBoundingClientRect();
  if (!f || !r.width || !r.height) return null;
  const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (f.width || frame.naturalWidth), y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * (f.height || frame.naturalHeight);
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}
const BUTTON = ['left', 'middle', 'right'];
let lastMove = 0, pressed = false;
frame.addEventListener('mousedown', (e) => {
  if (!S.own) return;
  const p = at(e); if (!p) return;
  e.preventDefault(); keys.focus({ preventScroll: true }); pressed = true;
  push({ t: 'down', ...p, button: BUTTON[e.button] || 'left', clicks: Math.max(1, Math.min(3, e.detail || 1)), buttons: e.buttons & 31, mods: mods(e) });
});
window.addEventListener('mouseup', (e) => {
  if (!S.own || !pressed) return;
  pressed = false;
  const p = at(e); if (p) push({ t: 'up', ...p, button: BUTTON[e.button] || 'left', clicks: Math.max(1, Math.min(3, e.detail || 1)), buttons: e.buttons & 31, mods: mods(e) });
});
frame.addEventListener('mousemove', (e) => {
  if (!S.own) return;
  const now = Date.now(); if (!e.buttons && now - lastMove < 50) return;
  lastMove = now;
  const p = at(e); if (p) push({ t: 'move', ...p, buttons: e.buttons & 31, mods: mods(e) });
});
frame.addEventListener('contextmenu', (e) => { if (S.own) e.preventDefault(); });
// (Reached by the keyboard, the picture of your tab hands what you type to your tab, as a click does.)
frame.addEventListener('focus', () => { if (S.own) keys.focus({ preventScroll: true }); });
frame.addEventListener('dragstart', (e) => e.preventDefault());
const SPECIAL = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Insert']);
keys.addEventListener('keydown', (e) => {
  if (!S.own || e.isComposing || e.keyCode === 229) return;          // (a composition: its text comes as input)
  if (['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock'].includes(e.key)) return;
  const shortcut = e.ctrlKey || e.metaKey;
  if (shortcut && (e.key === 'v' || e.key === 'V')) return;          // a paste: the paste event brings the editor's text
  if (shortcut && !e.altKey && /^[cx]$/i.test(e.key)) {
    // Copy and Cut: what is selected on your page goes on this editor's clipboard (Chrome's own is on the other
    // computer), read before the key reaches the page, so a Cut still has its text.
    e.preventDefault();
    const key = { t: 'key', key: e.key.slice(0, 40), code: e.code.slice(0, 40), mods: mods(e) };
    void copyOut().finally(() => push(key));
    return;
  }
  if (e.key.length === 1 && !shortcut && !(e.altKey && !e.getModifierState?.('AltGraph'))) {
    e.preventDefault(); push({ t: 'key', key: e.key, code: e.code.slice(0, 40), text: e.key, mods: mods(e) & 8 }); return;
  }
  if (SPECIAL.has(e.key) || shortcut || e.altKey) { e.preventDefault(); push({ t: 'key', key: e.key.slice(0, 40), code: e.code.slice(0, 40), mods: mods(e) }); }
});
keys.addEventListener('input', () => { const text = keys.value; keys.value = ''; if (S.own && text) push({ t: 'text', text: text.slice(0, 8000) }); });
keys.addEventListener('paste', (e) => {
  if (!S.own) return;
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') || '';
  if (text) push({ t: 'text', text: text.slice(0, 8000) });
});
// The page is laid out at this tab's size (DGC sizes your tab to it), so its picture is drawn one to one.
let sized = '', sizeTimer = 0;
function sizeOwn() {
  if (!S.own || !ready()) return;
  const width = Math.floor(stage.clientWidth - 18), height = Math.floor(stage.clientHeight - 18);
  if (width < 50 || height < 50) return;
  const said = `${width}x${height}`;
  if (said === sized) return;
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(() => { sized = said; void actOwn('size', { width, height }); }, sized ? 250 : 0);
}
if (typeof ResizeObserver === 'function') new ResizeObserver(() => sizeOwn()).observe(stage);

let polling = 0;
async function poll() {
  if (S.own) { void streamOwn(); return; }
  if (!ready() || document.hidden || S.busy) return;
  S.busy = true;
  try { took(await ask('use_your_browser_view', { op: 'frame' })); }
  catch (error) { S.note = String(error?.message || 'No picture yet.'); paint(); }
  finally { S.busy = false; }
}
function took(said) {
  if (said?.ok && typeof said.image === 'string' && said.image.startsWith('data:image/')) {
    S.frame = { image: said.image, url: String(said.url || ''), title: String(said.title || ''), width: Number(said.width) || 0, height: Number(said.height) || 0 };
    S.note = '';
    if (Array.isArray(said.lanes)) S.lanes = said.lanes.filter((l) => l && typeof l.pip_id === 'string').slice(0, 20);
  } else if (said && said.ok === false) {
    S.note = String(said.error || 'No picture yet.');
    if (said.closed) S.frame = null;
  }
  paint();
}
function start() {
  if (S.own) { sizeOwn(); void streamOwn(); return; }
  if (!polling) polling = setInterval(poll, POLL_MS); void poll();
}

/** The person's own hand in the Pip's tab; the next picture shows what it did. */
async function act(op, fields = {}) {
  if (S.own) { void actOwn(op, fields); return; }
  if (!ready()) return;
  try { took(await ask('use_your_browser_view', { op, ...fields })); }
  catch (error) { S.note = String(error?.message || 'That didn’t reach the tab.'); paint(); }
}
frame.addEventListener('click', (e) => {
  if (S.own) return;                                   // (your own tab: mousedown and mouseup, as they happen)
  const f = S.frame; if (!f || !frame.clientWidth) return;
  const r = frame.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * (f.width || frame.naturalWidth), y = ((e.clientY - r.top) / r.height) * (f.height || frame.naturalHeight);
  frame.focus({ preventScroll: true });
  void act('click', { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
});
let wheel = 0, wheelTimer = 0;
frame.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (S.own) { const p = at(e); if (p) push({ t: 'wheel', ...p, dx: Math.round(e.deltaX * (e.deltaMode === 1 ? 16 : 1)), dy: Math.round(e.deltaY * (e.deltaMode === 1 ? 16 : 1)), mods: mods(e) }); return; }
  wheel += e.deltaY * (e.deltaMode === 1 ? 16 : 1);
  if (!wheelTimer) wheelTimer = setTimeout(() => { const dy = Math.max(-3000, Math.min(3000, wheel)); wheel = 0; wheelTimer = 0; if (dy) void act('scroll', { dy }); }, 120);
}, { passive: false });
const KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Home', 'End', 'PageUp', 'PageDown']);
let typed = '', typeTimer = 0;
const flush = () => { clearTimeout(typeTimer); typeTimer = 0; const text = typed; typed = ''; if (text) void act('type', { text }); };
frame.addEventListener('keydown', (e) => {
  if (S.own) return;                                   // (your own tab: what you type is caught by its key field)
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (KEYS.has(e.key)) { e.preventDefault(); flush(); void act('key', { key: e.key }); return; }
  if (e.key.length === 1) { e.preventDefault(); typed += e.key; clearTimeout(typeTimer); typeTimer = setTimeout(flush, 150); }
});
$('.yb-address').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = url.value.trim(); S.typing = false;
  if (text) void act('go', { url: text });
});
url.addEventListener('input', () => { S.typing = true; });
url.addEventListener('keydown', (e) => { if (e.key === 'Escape') { S.typing = false; url.value = S.frame?.url || ''; url.blur(); } });
url.addEventListener('blur', () => { S.typing = false; });
$('.yb-back').addEventListener('click', () => void act('back'));
$('.yb-forward').addEventListener('click', () => void act('forward'));
$('.yb-reload').addEventListener('click', () => void act('reload'));
$('.yb-window').addEventListener('click', () => { if (ready()) ask('open_your_browser').catch((error) => { S.note = String(error?.message || ''); paint(); }); });
tabs.addEventListener('click', (e) => {
  if (S.own) {
    const close = e.target.closest('[data-close]'), pick = e.target.closest('[data-tab]');
    if (e.target.closest('.yb-new')) void actOwn('new_tab');
    else if (close) void actOwn('close_tab', { tab: close.dataset.close });
    else if (pick && pick.dataset.tab !== S.current) void actOwn('tab', { tab: pick.dataset.tab });
    return;
  }
  const tab = e.target.closest('.yb-tab');
  if (tab && tab.dataset.pip !== S.pip?.id) vscode.postMessage({ type: 'pipsOpenYourBrowser', pip: { id: tab.dataset.pip, name: tab.dataset.name } });
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });

window.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'yourBrowserInit' && msg.own === true) { S.own = true; S.pip = null; paint(); if (ready()) start(); return; }
  if (msg.type === 'yourBrowserInit' && msg.pip && typeof msg.pip.id === 'string') { S.pip = { id: msg.pip.id, name: String(msg.pip.name || 'A Pip') }; paint(); if (ready()) start(); return; }
  if (msg.type === 'pipsConnection') {
    if (msg.generation !== S.generation) { for (const p of S.pending.values()) { clearTimeout(p.timer); p.reject(new Error('The connection changed.')); } S.pending.clear(); }
    S.generation = msg.generation; S.connected = msg.connected === true && msg.supported !== false && msg.enabled === true; S.api = Number(msg.apiVersion) || 0;
    S.note = !S.connected ? 'Connecting to local DGC…' : S.api < API ? (S.own ? 'Update DGC to use Your Browser here.' : 'Update DGC to watch a Pip’s tab in Your Browser.') : S.note === 'Connecting to local DGC…' ? '' : S.note;
    paint(); if (ready()) start();
    return;
  }
  if (msg.type === 'pipsReply') {
    const p = S.pending.get(msg.id); if (!p) return;
    S.pending.delete(msg.id); clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error?.message || 'DGC couldn’t do that.'));
  }
});
// What went wrong, and the line about what can't work here, can each be closed; "Connecting…" is work in progress.
window.DgcDismiss?.watch({ root: app, lines: [{ sel: '.yb-note', when: (l) => !/…$/.test(l.textContent.trim()), focus: () => url }, { sel: '.yb-line', focus: () => url }] });
paint();
vscode.postMessage({ type: 'pipsReady' });
