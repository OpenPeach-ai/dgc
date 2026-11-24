// One screen in an editor tab, shown with the RFB viewer. A Pip computer's desktop and Your Browser's own window (where
// the computer DGC runs on has no screen) are this one piece: the screen's bytes ride the extension host's messages (the
// page never holds a socket, a path or a token), Copy and Paste go straight through it, the page can ask the screen
// for the size of the tab it is shown in, and the screen is shown and zoomed the same way in both (Fit or 100%).
import './screenView.css';

/** Bytes as base64, and back. */
export function toB64(bytes) { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(text); }
export function fromB64(text) { const raw = atob(text), out = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out; }

/** What the viewer sees as its WebSocket: `post` carries the viewer's bytes to the host ({op: 'send', data}) and its
 *  close ({op: 'close'}); deliver() hands it the screen's bytes as they come. */
export class ScreenChannel {
  constructor(post) { this.post = post; this.binaryType = 'arraybuffer'; this.protocol = ''; this.readyState = 'connecting'; this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null; }
  send(data) { if (this.readyState !== 'open') return; const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data); this.post({ op: 'send', data: toB64(bytes) }); }
  close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.post({ op: 'close' }); this.onclose?.({ code: 1000, reason: '', wasClean: true }); }
  // The viewer attaches a moment after it is made. Bytes that arrive before it listens wait for it, in order: handed to
  // no one, the server's first words were lost and the screen never opened.
  deliver(text, held = false) {
    if (this.readyState === 'closed') return;
    if (!held && (this.early || !this.onmessage)) { (this.early ||= []).push(text); if (!this.earlyTimer) this.earlyTimer = setInterval(() => this.flushEarly(), 5); return; }
    if (this.readyState === 'connecting') { this.readyState = 'open'; this.onopen?.(); }
    const bytes = fromB64(text); this.onmessage?.({ data: bytes.buffer });
  }
  flushEarly() {
    if (this.readyState !== 'closed' && !this.onmessage) return;
    clearInterval(this.earlyTimer); this.earlyTimer = null; const early = this.early || []; this.early = null;
    for (const text of early) this.deliver(text, true);
  }
  end(reason) { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.onclose?.({ code: 1000, reason, wasClean: false }); }
}

/** Copy and Paste straight through a screen. Ctrl+C or Ctrl+X on it: what it copies next comes to your
 *  clipboard (copied(), from the viewer's 'clipboard' event); a copy made there with no key of yours leaves your
 *  clipboard alone. Ctrl+V on it: the key waits for the paste with your text, which goes onto its clipboard first, then
 *  Ctrl+V reaches it. `viewer()` is the viewer on show, `onScreen(node)` whether a node is its screen, `mayType()`
 *  whether your keys go to it now. */
export function clipboardThrough(doc, { viewer, onScreen, mayType = () => true, maxBytes = 1000000 }) {
  let copyAt = 0, pasteFor = null;
  const bytesOf = (text) => new TextEncoder().encode(text).length;
  doc.addEventListener('keydown', (event) => {
    const v = viewer();
    if (!v || !onScreen(event.target) || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    const key = String(event.key || '').toLowerCase();
    if (key === 'c' || key === 'x') { copyAt = Date.now(); return; }
    if (key === 'v' && mayType() && typeof v.clipboardPasteFrom === 'function') { event.stopImmediatePropagation(); pasteFor = v; }
  }, true);
  doc.addEventListener('paste', (event) => {
    const into = pasteFor; pasteFor = null;
    if (!into || into !== viewer() || !onScreen(event.target)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const text = event.clipboardData?.getData?.('text/plain') || '';
    if (text && bytesOf(text) <= maxBytes) into.clipboardPasteFrom(text);
    const CONTROL = 0xffe3, V = 0x76;
    into.sendKey(CONTROL, 'ControlLeft', true); into.sendKey(V, 'KeyV', true); into.sendKey(V, 'KeyV', false); into.sendKey(CONTROL, 'ControlLeft', false);
  }, true);
  return {
    /** What the screen copied: onto your clipboard when your own Copy or Cut asked for it a moment ago. */
    copied(text) {
      if (!text || Date.now() - copyAt >= 4000) return false;
      copyAt = 0; void globalThis.navigator?.clipboard?.writeText?.(text)?.catch?.(() => {});
      return true;
    },
  };
}

/** Ask the screen to be `width` × `height` of its own pixels (RFB's SetDesktopSize, which a screen offers its viewers
 *  once it has said its size). False when it can't be asked (yet): the picture is then scaled to fit. */
export function askScreenSize(viewer, width, height) {
  const w = Math.max(64, Math.min(16384, Math.round(width))), h = Math.max(64, Math.min(16384, Math.round(height)));
  const say = viewer?.constructor?.messages?.setDesktopSize;
  if (!viewer || !viewer._supportsSetDesktopSize || typeof say !== 'function' || !viewer._sock) return false;
  if (viewer._fbWidth === w && viewer._fbHeight === h) return true;
  say(viewer._sock, w, h, viewer._screenID, viewer._screenFlags);
  return true;
}

/** How every screen is shown in its tab, the same for a Pip's computer and Your Browser's own screen: the viewer never
 *  resizes the screen by itself, takes the keyboard on a click and paints no ground of its own; the stream is the
 *  viewer's own (its encodings, at quality 6 and compression 2, the viewer's defaults, said here so both stay the same);
 *  and the picture is the screen's own pixels, one for each of the tab's, the tab's room scrolling to the rest, unless
 *  Fit is chosen: then it is scaled to the tab with its shape kept. */
export const SCREEN_QUALITY = 6, SCREEN_COMPRESSION = 2;
export function showScreen(viewer, fit) {
  viewer.scaleViewport = !!fit; viewer.clipViewport = false; viewer.resizeSession = false; viewer.focusOnClick = true;
  viewer.background = 'transparent'; viewer.qualityLevel = SCREEN_QUALITY; viewer.compressionLevel = SCREEN_COMPRESSION;
}
/** Fit or 100% on a screen already shown. */
export function fitScreenTo(viewer, fit) {
  if (viewer && 'scaleViewport' in viewer && viewer.scaleViewport !== !!fit) { viewer.clipViewport = false; viewer.scaleViewport = !!fit; }
}
/** Fit and 100%, one pair of buttons, the same words, titles and look on every screen. `fitId`, `actualId`: the two
 *  buttons' ids; `cls` and `groupCls`: a page's own class on the buttons and on the pair (a Pip computer's bar sizes and
 *  folds its tools by them). */
export function zoomMarkup(fit, { fitId, actualId, cls = '', groupCls = '' }) {
  const button = (id, on, words, title) => `<button type="button" id="${id}" class="dgc-btn small dgc-zoom-btn${cls ? ` ${cls}` : ''}" aria-pressed="${on}" title="${title}">${words}</button>`;
  return `<span class="dgc-zoom${groupCls ? ` ${groupCls}` : ''}" role="group" aria-label="Zoom">${button(fitId, !!fit, 'Fit', 'Fit the screen to this tab')}${button(actualId, !fit, '100%', 'Real size: scroll to see the rest')}</span>`;
}
