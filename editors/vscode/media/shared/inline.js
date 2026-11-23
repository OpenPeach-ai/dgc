// Inline touches in what you type and what you read, the same on every surface (Work, ChatDGC, a Pip's chat): a colour
// code wears a small square of that exact colour, a keyboard shortcut is drawn as keys, a commit and an issue are links
// where the project's Git says so, a time with a zone tells this computer's time, and a code worth copying (a colour, a
// commit, an API path) copies on a click. One module: the reading half (scan, no page needed) and the drawing half
// (decorate what a chat shows). The prompt box is never decorated: what you type stays your plain words (decided 16 Nov).
//
//   DgcInline.scan(text, { code, colours, keys, times, commits, issues, now }) -> [{ kind, start, end, text, ... }]
//   DgcInline.watch(root, { rules: [{ sel, colours, keys, times, refs }], copy(text), refs })
//       -> { dispose(), refresh(), refsAnswer({ scope, remote, github, known }) }
//     refs: { scope(): string | "", ask(hashes), open(hash) }: the page never runs git; it asks its host.
// A classic script (window.DgcInline); the Pips bundle imports it.
(function (root) {
  "use strict";

  // ---- reading ---------------------------------------------------------------------------------------------------
  const MODS = "Ctrl|CTRL|Control|Cmd|CMD|Command|Alt|ALT|Option|Opt|Shift|SHIFT|Meta|Win|Super";
  const NAMED = "F(?:1\\d|2[0-4]|[1-9])|Enter|Return|Tab|Escape|Esc|Spacebar|Space|Backspace|Delete|Del|Insert|Ins|Home|End|PageUp|PageDown|PgUp|PgDn|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Up|Down|Left|Right";
  const KEY = `(?:${NAMED}|[A-Za-z0-9]|[\`\\-=\\[\\]\\\\;',.\\/])`;
  const SYM = "⌘⌥⌃⇧";
  const KEYS_WORDS = new RegExp(`(^|[^\\w+])((?:${MODS})(?:\\+(?:${MODS}))*\\+${KEY})(?![\\w+])`, "g");
  const KEYS_SYMS = new RegExp(`(^|[^\\w${SYM}])([${SYM}]+\\+?${KEY})(?![\\w+])`, "g");
  const KEYS_WHOLE = new RegExp(`^(?:(?:${MODS})(?:\\+(?:${MODS}))*\\+${KEY}|[${SYM}]+\\+?${KEY}|F(?:1\\d|2[0-4]|[1-9])|Esc|Escape|Enter|Return|Tab|Backspace|PageUp|PageDown|[↑↓←→])$`);
  const HEX = /(^|[^\w#&\/.:=?@-])(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3}))(?![\w-])/g;
  const FUNC = /(^|[^\w-])((?:rgba?|hsla?|oklch)\(\s*[-+\d.%,\s\/a-z]{1,60}?\))/gi;
  const ISSUE_WORD = /(?:issues?|prs?|pull requests?|bugs?|tickets?|fix(?:e[sd])?|close[sd]?|resolve[sd]?|#)\s*$/i;
  const COMMIT = /(^|[^\w#\/.@:=+-])([0-9a-f]{7,40})(?![\w]|[.\-\/]\w)/g;
  const ISSUE_FULL = /(^|[^\w\/.#&-])([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][\w.-]*#(\d{1,7}))(?![\w-])/g;
  const ISSUE_SHORT = /(^|[^\w\/.#&-])(#(\d{1,7}))(?![\w-])/g;
  const ZONES = { UTC: 0, GMT: 0, PST: -480, PDT: -420, MST: -420, MDT: -360, CST: -360, CDT: -300, EST: -300, EDT: -240, AKST: -540, AKDT: -480, HST: -600, IST: 330, BST: 60, WET: 0, WEST: 60,
    CET: 60, CEST: 120, EET: 120, EEST: 180, MSK: 180, GST: 240, PKT: 300, SGT: 480, HKT: 480, JST: 540, KST: 540, AWST: 480, ACST: 570, AEST: 600, AEDT: 660, NZST: 720, NZDT: 780 };
  const PLACES = { PT: "America/Los_Angeles", MT: "America/Denver", CT: "America/Chicago", ET: "America/New_York" };       // (the zone's own summer or winter time)
  const ZONE = `(?:${Object.keys(ZONES).concat(Object.keys(PLACES)).sort((a, b) => b.length - a.length).join("|")})(?:[+-]\\d{1,2}(?::?\\d{2})?)?|[+-]\\d{2}:?\\d{2}`;
  const TIME_CLOCK = new RegExp(`(^|[^\\w:.+-])((\\d{1,2}):(\\d{2})(?::\\d{2})?(?:\\s?([AaPp])\\.?[Mm]\\.?)?\\s?(${ZONE}))(?![\\w:])`, "g");
  const TIME_HOUR = new RegExp(`(^|[^\\w:.+-])((\\d{1,2})\\s?([AaPp])\\.?[Mm]\\.?\\s?(${ZONE}))(?![\\w:])`, "g");
  const API = /^(?:(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/\S*|\/(?:api|v\d+)(?:\/[\w\-.{}:~%]+)+\/?(?:\?\S*)?|\/[\w\-.\/:]*\{\w+\}[\w\-.\/{}:]*)$/;

  const num = (s) => /^[-+]?(?:\d+\.?\d*|\.\d+)(?:%|deg|rad|turn|grad)?$/.test(s);
  /** rgb()/hsl()/oklch() with the numbers it needs (a page checks again with the browser's own reading). */
  function funcOk(text) {
    const m = /^([a-z]+)\(([^()]*)\)$/i.exec(text); if (!m) return false;
    const parts = m[2].trim().split(/[\s,\/]+/).filter(Boolean);
    return (parts.length === 3 || parts.length === 4) && parts.every(num);
  }
  /** `#123`: an issue's number far more often than a colour. The same digit three times (#000, #999) is a grey. */
  function hexOk(code, before, issues) {
    const d = code.slice(1);
    if (!/^\d+$/.test(d)) return !ISSUE_WORD.test(before) || /[a-fA-F]/.test(d) && d.length !== 3;
    if (ISSUE_WORD.test(before)) return false;
    if (d.length !== 3) return true;
    return issues ? d === "000" : d[0] === d[1] && d[1] === d[2];
  }
  function offsetOf(zone, now) {
    const m = /^([A-Z]+)?(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/.exec(zone); if (!m) return null;
    let base = 0;
    if (m[1]) {
      if (m[1] in ZONES) base = ZONES[m[1]];
      else if (m[1] in PLACES) {
        try { const parts = new Intl.DateTimeFormat("en-US", { timeZone: PLACES[m[1]], timeZoneName: "shortOffset" }).formatToParts(new Date(now)), z = (parts.find((p) => p.type === "timeZoneName") || {}).value || "";
          const o = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(z); base = o ? (o[1] === "-" ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3] || 0)) : 0; } catch { return null; }
      } else return null;
      if (m[2] && m[1] !== "UTC" && m[1] !== "GMT") return null;
    }
    const extra = m[2] ? (m[2] === "-" ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4] || 0)) : 0;
    if (m[2] && (Number(m[3]) > 14 || Number(m[4] || 0) > 59)) return null;
    return base + extra;
  }
  /** The moment a time with a zone names: that clock time on the zone's own today. */
  function instant(hour, minute, half, zone, now) {
    let h = Number(hour); const min = Number(minute || 0);
    if (min > 59) return null;
    if (half) { if (h < 1 || h > 12) return null; h = (h % 12) + (/p/i.test(half) ? 12 : 0); } else if (h > 23) return null;
    const off = offsetOf(zone, now); if (off === null) return null;
    const there = new Date(now + off * 60000);
    return Date.UTC(there.getUTCFullYear(), there.getUTCMonth(), there.getUTCDate(), h, min) - off * 60000;
  }
  /** How far away a moment is, in words. */
  function away(at, now) {
    const diff = at - now, abs = Math.abs(diff), say = (n, unit) => (diff > 0 ? `in ${n} ${unit}${n === 1 ? "" : "s"}` : `${n} ${unit}${n === 1 ? "" : "s"} ago`);
    if (abs < 60000) return "now";
    if (abs < 3600000) return say(Math.round(abs / 60000), "minute");
    if (abs < 86400000) return say(Math.round(abs / 3600000), "hour");
    return say(Math.round(abs / 86400000), "day");
  }
  const hasBoth = (h) => /\d/.test(h) && /[a-f]/.test(h);

  /** What is in `text`. opts.code: the whole of one inline code (a lone key, an API path and a bare hash count there). */
  function scan(text, opts = {}) {
    const out = [], s = String(text || ""), now = opts.now ?? Date.now();
    const add = (kind, start, str, more) => out.push({ kind, start, end: start + str.length, text: str, ...more });
    const each = (re, fn) => { re.lastIndex = 0; for (let m; (m = re.exec(s));) { fn(m, m.index + m[1].length); if (m[0].length === 0) re.lastIndex += 1; else re.lastIndex = m.index + m[0].length - (/[\s(]$/.test(m[0]) ? 1 : 0); } };
    if (opts.code) {
      const whole = s.trim();
      if (opts.keys !== false && KEYS_WHOLE.test(whole)) return [{ kind: "keys", start: 0, end: s.length, text: whole }];
      if (API.test(whole)) return [{ kind: "api", start: 0, end: s.length, text: whole }];
      if (/^[0-9a-f]{7,40}$/.test(whole) && hasBoth(whole)) return [{ kind: "commit", start: 0, end: s.length, text: whole, bare: true }];
    }
    if (opts.issues) {
      each(ISSUE_FULL, (m, at) => add("issue", at, m[2], { repo: m[2].split("#")[0], number: Number(m[3]) }));
      each(ISSUE_SHORT, (m, at) => { if (Number(m[3]) > 0 && !(m[3] === "000")) add("issue", at, m[2], { repo: "", number: Number(m[3]) }); });
    }
    if (opts.colours !== false) {
      each(HEX, (m, at) => { if (hexOk(m[2], s.slice(Math.max(0, at - 24), at), !!opts.issues)) add("colour", at, m[2]); });
      each(FUNC, (m, at) => { if (funcOk(m[2])) add("colour", at, m[2]); });
    }
    if (opts.keys !== false && !opts.code) { each(KEYS_WORDS, (m, at) => add("keys", at, m[2])); each(KEYS_SYMS, (m, at) => add("keys", at, m[2])); }
    if (opts.times) {
      each(TIME_CLOCK, (m, at) => { const when = instant(m[3], m[4], m[5], m[6], now); if (when !== null) add("time", at, m[2], { at: when }); });
      each(TIME_HOUR, (m, at) => { const when = instant(m[3], 0, m[4], m[5], now); if (when !== null) add("time", at, m[2], { at: when }); });
    }
    if (opts.commits && !opts.code) each(COMMIT, (m, at) => { if (hasBoth(m[2])) add("commit", at, m[2]); });
    // One reading for each stretch: the first, and the longer of two that start together. A colour beats an issue's number.
    const rank = { colour: 0, issue: 1, keys: 2, time: 3, commit: 4, api: 5 };
    out.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || rank[a.kind] - rank[b.kind]);
    const kept = [];
    for (const t of out) {
      const last = kept[kept.length - 1];
      if (last && t.start < last.end) { if (t.start === last.start && t.end === last.end && rank[t.kind] < rank[last.kind]) kept[kept.length - 1] = t; continue; }
      kept.push(t);
    }
    return kept;
  }

  const MOD_NAME = { ctrl: "ctrl", control: "ctrl", "⌃": "ctrl", cmd: "cmd", command: "cmd", "⌘": "cmd", meta: "cmd", win: "win", super: "win", alt: "alt", option: "alt", opt: "alt", "⌥": "alt", shift: "shift", "⇧": "shift" };
  const MOD_SHOWN = { mac: { ctrl: "⌃", cmd: "⌘", win: "⌘", alt: "⌥", shift: "⇧" }, other: { ctrl: "Ctrl", cmd: "Ctrl", win: "Win", alt: "Alt", shift: "Shift" } };
  const KEY_SHOWN = { left: "←", arrowleft: "←", right: "→", arrowright: "→", up: "↑", arrowup: "↑", down: "↓", arrowdown: "↓", escape: "Esc", esc: "Esc", return: "Enter", enter: "Enter", spacebar: "Space", del: "Delete", ins: "Insert", pgup: "PageUp", pgdn: "PageDown" };
  /** A shortcut's keys, each named the way this computer names it (Option is Alt off a Mac; ⌘ is Ctrl there). */
  function keysOf(text, { mac = false } = {}) {
    const parts = []; let rest = String(text || "").trim();
    for (;;) {
      const sym = new RegExp(`^[${SYM}]`).exec(rest);
      if (sym) { parts.push(sym[0]); rest = rest.slice(1).replace(/^\+/, ""); continue; }
      const word = new RegExp(`^(${MODS})\\+`).exec(rest);
      if (word) { parts.push(word[1]); rest = rest.slice(word[0].length); continue; }
      break;
    }
    const shown = [];
    for (const p of parts) { const name = (mac ? MOD_SHOWN.mac : MOD_SHOWN.other)[MOD_NAME[p.toLowerCase()]] || p; if (!shown.includes(name)) shown.push(name); }
    if (rest) shown.push(KEY_SHOWN[rest.toLowerCase()] || (rest.length === 1 ? rest.toUpperCase() : rest));
    return shown;
  }
  const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  /** A colour's three names, from its red, green, blue and alpha. */
  function names({ r, g, b, a = 1 }) {
    const alpha = a < 1, A = Math.round(a * 100) / 100;
    const R = r / 255, G = g / 255, B = b / 255, max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min, l = (max + min) / 2;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0; if (d !== 0) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
    h = Math.round(h * 60); if (h < 0) h += 360;
    const S = Math.round(s * 100), L = Math.round(l * 100);
    return { hex: `#${hex2(r)}${hex2(g)}${hex2(b)}${alpha ? hex2(a * 255) : ""}`, rgb: alpha ? `rgba(${r}, ${g}, ${b}, ${A})` : `rgb(${r}, ${g}, ${b})`, hsl: alpha ? `hsla(${h}, ${S}%, ${L}%, ${A})` : `hsl(${h}, ${S}%, ${L}%)` };
  }

  // ---- drawing (a page) -------------------------------------------------------------------------------------------
  const doc = root.document;
  const isMac = () => { try { return /mac|iphone|ipad/i.test((root.navigator.userAgentData && root.navigator.userAgentData.platform) || root.navigator.platform || ""); } catch { return false; } };
  const rgbaCache = new Map();
  /** The colour a code names, as the browser reads it (null: it reads none). */
  function rgbaOf(code) {
    if (rgbaCache.has(code)) return rgbaCache.get(code);
    let out = null;
    try {
      if (root.CSS && root.CSS.supports && root.CSS.supports("color", code)) {
        const c = doc.createElement("canvas"); c.width = c.height = 1; const g = c.getContext("2d", { willReadFrequently: true });
        g.clearRect(0, 0, 1, 1); g.fillStyle = code; g.fillRect(0, 0, 1, 1);
        const [r, gr, b, a] = g.getImageData(0, 0, 1, 1).data;
        // (An opaque colour reads back exactly; a see-through one is read once more over white and black for its true parts.)
        if (a === 255) out = { r, g: gr, b, a: 1 };
        else { const probe = doc.createElement("span"); probe.style.color = code; const m = /rgba?\(([^)]+)\)/.exec(probe.style.color || "");
          const p = m ? m[1].split(/[\s,\/]+/).map(Number) : null; out = p && p.length >= 3 && p.every((n) => Number.isFinite(n)) ? { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } : { r, g: gr, b, a: Math.round(a / 2.55) / 100 }; }
      }
    } catch { out = null; }
    rgbaCache.set(code, out);
    return out;
  }
  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const SKIP = "pre, a, button, kbd, textarea, input, select, script, style, svg, .dgc-il, .md-link, .md-math, .katex, .composer-pill, [contenteditable='true'], [data-il-skip]";

  function swatch(code, tag = "button") {
    const rgba = rgbaOf(code); if (!rgba) return null;
    const n = names(rgba), b = el(tag, "dgc-il-sw");
    if (tag === "button") { b.type = "button"; b.setAttribute("aria-label", `Colour ${code}: copy`); b.title = `${n.hex} · ${n.rgb} · ${n.hsl} · Click to copy`; }
    else b.setAttribute("aria-hidden", "true");
    b.dataset.colour = code; b.style.backgroundColor = code;
    return b;
  }
  function keysNode(text, mac) {
    const caps = keysOf(text, { mac }), wrap = el("span", "dgc-il dgc-il-keys"); wrap.dataset.as = text;
    caps.forEach((cap, i) => { if (i && !mac) wrap.append("+"); wrap.append(el("kbd", "dgc-il-key", cap)); });
    if (caps.join(mac ? "" : "+") !== text) wrap.title = `As written: ${text}`;
    return wrap;
  }
  const clock = (at) => { try { return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch { return new Date(at).toISOString().slice(11, 16); } };
  function timeWords(at, now = Date.now()) {
    const a = new Date(at), n = new Date(now), day = Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()) - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 86400000);
    const when = day === 0 ? "" : day === 1 ? ", tomorrow" : day === -1 ? ", yesterday" : `, ${a.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}`;
    return `${clock(at)} your time${when} · ${away(at, now)}`;
  }
  function timeNode(token) { const n = el("span", "dgc-il dgc-il-time", token.text); n.dataset.at = String(token.at); n.tabIndex = 0; n.title = timeWords(token.at); return n; }
  function commitNode(hash) { const b = el("button", "dgc-il dgc-il-commit", hash); b.type = "button"; b.dataset.hash = hash; b.title = `Open commit ${hash.slice(0, 12)} · Alt+click copies it`; return b; }
  function issueNode(text, repo, number) {
    const url = `https://github.com/${repo}/issues/${number}`, b = el("button", "md-link dgc-il dgc-il-issue", text);
    b.type = "button"; b.dataset.linkKind = "external"; b.dataset.target = url; b.dataset.href = url; b.title = url;
    return b;
  }
  const maybe = (text, data) => { const n = el("span", "dgc-il dgc-il-maybe", text); Object.assign(n.dataset, data); return n; };
  const copyable = (node, text) => { node.classList.add("dgc-il-copy"); node.dataset.copy = text; node.tabIndex = 0; node.setAttribute("role", "button"); node.title = "Click to copy"; };

  /** Draws the touches inside `container`, once: what it has already drawn is left alone. */
  function decorate(container, rule, ctx) {
    if (!container || !doc) return;
    const mac = ctx.mac, refs = rule.refs ? ctx.refsState() : null;
    const opts = { colours: rule.colours !== false, keys: rule.keys !== false, times: !!rule.times, commits: !!refs && refs.remote !== false, issues: !!refs && (refs.github === null || !!refs.github) };
    const walker = doc.createTreeWalker(container, 4 /* text */, { acceptNode: (t) => (!t.nodeValue || t.nodeValue.length < 2 || (t.parentElement && t.parentElement.closest(SKIP) && container.contains(t.parentElement.closest(SKIP))) ? 2 : 1) });
    const nodes = []; for (let n; (n = walker.nextNode());) nodes.push(n);
    for (const node of nodes) {
      const parent = node.parentElement; if (!parent) continue;
      const code = parent.tagName === "CODE" ? parent : null;
      if (code && code.dataset.il) continue;
      const whole = code && code.childNodes.length === 1;
      const tokens = scan(node.nodeValue, { ...opts, code: !!whole });
      if (code) code.dataset.il = "1";
      if (!tokens.length) continue;
      if (whole && tokens.length === 1 && tokens[0].start === 0 && tokens[0].end === node.nodeValue.length && tokens[0].kind !== "colour") {
        const t = tokens[0];
        if (t.kind === "keys") code.replaceWith(keysNode(t.text, mac));
        else if (t.kind === "api") copyable(code, t.text);
        else if (t.kind === "commit") {
          const known = refs && refs.remote !== false ? refs.known.get(t.text) : false;
          copyable(code, t.text);                                       // a hash in code copies on a click, a commit or not
          if (known === true) { code.textContent = ""; code.append(commitNode(t.text)); code.classList.remove("dgc-il-copy"); code.removeAttribute("role"); code.removeAttribute("tabindex"); code.removeAttribute("title"); }
          else if (known === undefined && refs) { code.classList.add("dgc-il-maybe"); code.dataset.hash = t.text; ctx.ask([t.text]); }
        }
        continue;
      }
      const frag = doc.createDocumentFragment(); let at = 0, drew = false; const text = node.nodeValue;
      for (const t of tokens) {
        let made = null;
        if (t.kind === "colour") { const sw = swatch(t.text); if (sw) { made = el("span", "dgc-il dgc-il-colour"); made.append(t.text, sw); } }
        else if (t.kind === "keys") made = keysNode(t.text, mac);
        else if (t.kind === "time") made = timeNode(t);
        else if (t.kind === "commit") { const known = refs.known.get(t.text); if (known === true) made = commitNode(t.text); else if (known === undefined) { made = maybe(t.text, { hash: t.text }); ctx.ask([t.text]); } }
        else if (t.kind === "issue") {
          if (refs.github) made = issueNode(t.text, t.repo || refs.github, t.number);
          else if (refs.github === null) { made = maybe(t.text, { issue: String(t.number), repo: t.repo || "" }); ctx.ask([]); }
        }
        if (!made) continue;
        frag.append(text.slice(at, t.start), made); at = t.end; drew = true;
      }
      if (!drew) continue;
      frag.append(text.slice(at));
      node.replaceWith(frag);
    }
  }

  // ---- watching a page (or a shadow root) -------------------------------------------------------------------------
  function watch(base, { rules = [], copy, refs = null } = {}) {
    if (!doc || !base) return { dispose() {}, refresh() {}, refsAnswer() {} };
    const mac = isMac(), states = new Map(), asked = new Set();
    let pending = [], askSoon = false;
    const scopeNow = () => (refs ? String(refs.scope() || "") : "");
    const stateOf = (scope) => { if (!states.has(scope)) states.set(scope, { remote: null, github: null, known: new Map() }); return states.get(scope); };
    const ctx = { mac, refsState: () => (refs && scopeNow() ? stateOf(scopeNow()) : null),
      ask(hashes) {
        const scope = scopeNow(); if (!scope) return;
        const fresh = hashes.filter((h) => !asked.has(`${scope} ${h}`)); fresh.forEach((h) => asked.add(`${scope} ${h}`));
        if (!fresh.length && asked.has(`${scope} `)) return;
        asked.add(`${scope} `); pending.push(...fresh);
        if (!askSoon) { askSoon = true; Promise.resolve().then(() => { askSoon = false; const list = [...new Set(pending)].slice(0, 64); pending = []; if (scopeNow() === scope) refs.ask(list); }); }
      } };
    const all = (sel) => { try { return [...base.querySelectorAll(sel)]; } catch { return []; } };
    let observer = null;
    function run(targets) {
      for (const rule of rules) for (const node of targets ? targets.filter((n) => n.matches && n.matches(rule.sel)) : all(rule.sel)) { try { decorate(node, { ...rule, refs: rule.refs && refs && scopeNow() ? true : false }, ctx); } catch { /* a reply is never lost to a touch */ } }
      if (observer) observer.takeRecords();                      // what was just drawn is not news
    }
    const refresh = () => run(null);
    if (typeof root.MutationObserver === "function") {
      const every = rules.map((r) => r.sel).join(", ");
      observer = new root.MutationObserver((records) => {
        const found = new Set();
        for (const rec of records) {
          const t = rec.target.nodeType === 1 ? rec.target : rec.target.parentElement; if (!t) continue;
          const up = every && t.closest ? t.closest(every) : null; if (up) found.add(up);
          for (const n of rec.addedNodes) { if (n.nodeType !== 1) continue; if (every) { if (n.matches(every)) found.add(n); n.querySelectorAll(every).forEach((x) => found.add(x)); } }
        }
        if (found.size) run([...found]);
      });
      observer.observe(base, { childList: true, subtree: true, characterData: true });
    }
    // A click: a swatch or a code copies (never the click that ends a selection), a commit opens through the host.
    const said = (node) => {
      node.classList.add("dgc-il-copied"); root.clearTimeout(node._ilTick);
      node._ilTick = root.setTimeout(() => node.classList.remove("dgc-il-copied"), 1500);
      let live = base.querySelector(".dgc-il-live"); if (!live) { live = el("span", "dgc-il-live"); live.setAttribute("aria-live", "polite"); (base.body || base).append(live); }
      live.textContent = ""; live.textContent = "Copied";
    };
    const selecting = (node) => { try { const scope = node.getRootNode(), sel = (scope.getSelection ? scope.getSelection() : null) || doc.getSelection(); return !!sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.containsNode(node, true); } catch { return false; } };
    const act = (event) => {
      const t = event.target && event.target.closest ? event.target.closest(".dgc-il-sw, .dgc-il-commit, .dgc-il-copy") : null;
      if (!t || !base.contains(t)) return;
      if (event.type === "keydown") { if ((event.key !== "Enter" && event.key !== " ") || t.tagName === "BUTTON") return; }
      if (t.classList.contains("dgc-il-commit") && !event.altKey) { event.preventDefault(); event.stopPropagation(); if (refs) refs.open(t.dataset.hash); return; }
      if (t.classList.contains("dgc-il-copy") && selecting(t)) return;
      event.preventDefault(); event.stopPropagation();
      const text = t.dataset.colour || t.dataset.copy || t.dataset.hash || "";
      if (text && copy) { copy(text); said(t); }
    };
    base.addEventListener("click", act); base.addEventListener("keydown", act);
    // A time's words are true at the moment it is pointed at.
    const fresh = (event) => { const t = event.target && event.target.closest ? event.target.closest(".dgc-il-time") : null; if (t && t.dataset.at) { const words = timeWords(Number(t.dataset.at)); if (t.hasAttribute("title")) t.title = words; else if (t.dataset.tip !== undefined) t.dataset.tip = words; else t.title = words; } };
    base.addEventListener("pointerover", fresh, true); base.addEventListener("focusin", fresh, true);
    refresh();
    return {
      refresh,
      /** The host's answer: whether the project has a remote, its GitHub name, and which hashes are commits. */
      refsAnswer({ scope, remote, github, known } = {}) {
        const key = String(scope || scopeNow() || ""); if (!key) return;
        const s = stateOf(key); s.remote = remote === true; s.github = typeof github === "string" && /^[\w.-]+\/[\w.-]+$/.test(github) ? github : "";
        for (const [hash, yes] of Object.entries(known || {})) if (/^[0-9a-f]{7,40}$/.test(hash)) s.known.set(hash, yes === true && s.remote);
        if (key !== scopeNow()) return;
        for (const n of all(".dgc-il-maybe")) {
          if (n.dataset.hash) { const yes = s.known.get(n.dataset.hash); if (yes === undefined && s.remote) continue;
            if (n.tagName === "CODE") { n.classList.remove("dgc-il-maybe"); if (yes) { n.textContent = ""; n.append(commitNode(n.dataset.hash)); n.classList.remove("dgc-il-copy"); n.removeAttribute("role"); n.removeAttribute("tabindex"); n.removeAttribute("title"); } }
            else if (yes) n.replaceWith(commitNode(n.dataset.hash)); else n.replaceWith(doc.createTextNode(n.textContent)); }
          else if (n.dataset.issue) { if (s.github) n.replaceWith(issueNode(n.textContent, n.dataset.repo || s.github, Number(n.dataset.issue))); else { const plain = el("span", "dgc-il", n.textContent); n.replaceWith(plain); } }
        }
        if (observer) observer.takeRecords();
      },
      dispose() { if (observer) observer.disconnect(); base.removeEventListener("click", act); base.removeEventListener("keydown", act); base.removeEventListener("pointerover", fresh, true); base.removeEventListener("focusin", fresh, true); },
    };
  }

  root.DgcInline = { scan, keysOf, names, away, timeWords, watch };
})(typeof window !== "undefined" ? window : globalThis);
