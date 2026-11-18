// The 16 Nov third pass's scenes (uir2c-*.test.mjs, render-uir2c.mjs), built on the scenes each surface already has.
// Not a *.test.mjs file.
import * as chat from "./chat-scene.mjs";
import { launchArgs } from "./uir2a-scene.mjs";
export { launchArgs };

/** ChatDGC mid-reply with messages queued and (opts.draft) words typed in the box after them. `edit(n)` presses a
    queued row's Edit as a person does; `answer(role)` presses Keep draft / Replace draft; `box()` reads what shows. */
export async function openChatQueue(browser, { width = 440, height = 760, theme = "dark-modern", queued = ["And the budget?"], draft = "", scale } = {}) {
  const x = await chat.openChat(browser, { width, height, theme, scale });
  x.page.setDefaultTimeout(8000);
  await x.send({ type: "opened", conversation: chat.conversation({ title: "A week in Goa in March" }), earlier: 0, busy: false,
    messages: [{ id: chat.M(1), role: "user", text: "Plan a week in Goa in March.", created_at: "2026-11-10T09:30:00Z" }] });
  await x.send({ type: "models", ids: ["qwen3.8:27b"], current: "qwen3.8:27b" });
  await x.send({ type: "turn", state: "started", replyId: chat.M(2) });
  const input = x.page.locator("#cd-input");
  for (const text of queued) { await input.fill(text); await input.press("Enter"); await x.page.waitForTimeout(40); }
  if (draft) { await input.click(); await x.page.keyboard.type(draft); }
  /** The queue's rows open from its pill on the bar above the box. */
  const openRows = async () => { if (await x.page.locator("#cd-queue .dgc-queue-row").first().isVisible().catch(() => false)) return;
    await x.page.evaluate(() => ([...document.querySelectorAll(".dgc-tray button, #cd-tray button")].find((b) => /queued/i.test(b.textContent || b.getAttribute("aria-label") || "")))?.click());
    await x.page.waitForTimeout(150); };
  const edit = async (n) => { await openRows(); await x.page.locator('#cd-queue .dgc-queue-row [data-queue-role="edit"]').nth(n).click(); await x.page.waitForTimeout(80); };
  const answer = async (role) => { await x.page.locator(`#cd-queue [data-queue-role="${role}"]`).click(); await x.page.waitForTimeout(80); };
  const box = () => x.page.evaluate(() => { const input = document.getElementById("cd-input"), ask = document.querySelector("#cd-queue .dgc-queue-ask"), q = document.getElementById("cd-queue");
    const inside = (n) => { const r = n.getBoundingClientRect(), p = q.getBoundingClientRect(); return r.width > 0 && r.left >= p.left - 0.5 && r.right <= p.right + 0.5 && r.left >= 0 && r.right <= document.documentElement.clientWidth; };
    return { text: input.value, focus: document.activeElement === input, rows: [...document.querySelectorAll("#cd-queue .dgc-queue-row .cd-queue-text")].map((r) => r.textContent),
      ask: ask?.querySelector(".dgc-queue-ask-words")?.textContent.trim() || "", buttons: ask ? [...ask.querySelectorAll("button")].map((b) => b.textContent.trim()) : [],
      fits: ask ? [...ask.querySelectorAll("button"), ask].every(inside) && ask.getBoundingClientRect().bottom <= ask.closest(".dgc-queue-row").getBoundingClientRect().bottom + 0.5
        && (!ask.closest(".dgc-queue-row").nextElementSibling || ask.closest(".dgc-queue-row").nextElementSibling.getBoundingClientRect().top >= ask.getBoundingClientRect().bottom - 0.5) : true }; });
  return { ...x, openRows, edit, answer, box };
}

// ---- §1b: one action, one icon. Every control on a page with the action its name says and the glyph it draws. -----
/** What action a control's name says ("Open in editor: Fix the login" is Open in editor), or "" for none of the shared ones. */
export const ACTION_OF = `(label) => { const w = String(label || "").replace(/\\s+/g, " ").trim().toLowerCase();
  if (/^open (it )?in (the |an )?editor\\b/.test(w)) return "open-in-editor";
  if (/^more\\b/.test(w) || w === "…" || w === "...") return "more";
  if (/^back\\b/.test(w)) return "back";
  if (/^(pips |work |chat |sub-agent )?settings\\b/.test(w) || /^open settings\\b/.test(w)) return "settings";
  if (/^new (space|folder)\\b/.test(w)) return "";                 // (a new folder's own glyph: a folder with a plus)
  if (/^(new|add)\\b/.test(w)) return "add";
  if (/^close\\b/.test(w)) return "close";
  if (/^copy\\b/.test(w)) return "copy";
  if (/^(delete|remove)\\b/.test(w)) return "delete";
  if (/^pin\\b/.test(w)) return "pin";
  if (/^unpin\\b/.test(w)) return "unpin";
  if (/^archive\\b/.test(w) && !/^archived/.test(w)) return "archive";
  if (/^stop and\\b/.test(w)) return "";                           // (dictation's two ways to end: its own bar)
  if (/^stop\\b/.test(w)) return "stop";
  if (/^save to (the )?project\\b/.test(w)) return "";              // (into the project's folder: its own glyph, a file with an arrow)
  if (/^(save to (the |your )?library|in (the |your )?library)\\b/.test(w)) return "library";   // (Save to Library: the Library's own glyph)
  if (/^save\\b/.test(w)) return "save";
  return ""; }`;
/** Read in the page (document and every shadow root): each button or menu row that draws a glyph, with its action,
    the glyph's signature (the icon's name: an icon-font class or an inline drawing's data-icon; an unnamed drawing is
    its own markup) and the size it is drawn at. `where` names the surface in a failure. */
export const glyphs = (page, where) => page.evaluate(([src, where]) => { const actionOf = (0, eval)(src);
  const all = (root, s, out = []) => { out.push(...root.querySelectorAll(s)); for (const n of root.querySelectorAll("*")) if (n.shadowRoot) all(n.shadowRoot, s, out); return out; };
  const out = [];
  for (const b of all(document, 'button, [role="button"], [role="menuitem"], [role="menuitemradio"], a[href]')) {
    const own = (b.getAttribute("aria-label") || b.getAttribute("title") || "").trim(), words = (b.querySelector(".dgc-menu-label")?.textContent || b.textContent || "").trim();
    const label = own || words; let action = actionOf(label) || (own ? actionOf(words) : "");
    if (!action) continue;
    const font = b.querySelector(".codicon"), svg = [...b.querySelectorAll("svg")].find((s) => !s.closest(".pip-face, .dgc-mark, .hc-mark, .face, .plush"));
    let sig = "", size = 0, shown = b.getClientRects().length > 0;
    if (font) { sig = ([...font.classList].find((c) => c.startsWith("codicon-")) || "").slice(8) || `text:${font.textContent.trim()}`; size = parseFloat(getComputedStyle(font).fontSize); }
    else if (svg) { sig = svg.dataset.icon || `drawing:${svg.innerHTML.replace(/\\s+/g, " ").slice(0, 90)}`; size = svg.getBoundingClientRect().width; }
    else continue;                                   // a control with words only draws no glyph
    // New in a menu names a kind of thing (a Work session, a chat, a Pip) and wears that kind's mark, and New Pip
    // wears a Pip's face: neither is the "+" of New. The box's own Stop is the Send button's other state.
    if (action === "add" && (b.closest('[role="menu"], .dgc-menu, .dgc-pop') || /menuitem/.test(b.getAttribute("role") || "") || /^drawing:<image/.test(sig) || b.querySelector(".pip-face, .dgc-mark, .hc-mark, .mk, [class*=plush]"))) continue;
    if (action === "stop" && /^stop( generation| the reply)?$/i.test(label) && b.closest("form, footer, #cbox, .cd-box, #chat-form, .composer")) action = "stop-reply";
    out.push({ where, action, label: label.slice(0, 60), sig, size: Math.round(size * 10) / 10, shown, worded: !!(b.textContent || "").trim(), message: !!b.closest(".msg, .pip-message, .cd-msg, .response-actions, .message-actions, .cd-actions"), menu: !!b.closest('[role="menu"], .dgc-menu, .dgc-blob-menu') || /menuitem/.test(b.getAttribute("role") || "") });
  }
  return out; }, [ACTION_OF, where]);
/** Press every "More" button that shows, one at a time, reading the glyphs while its menu is open. */
export async function glyphsWithMenus(page, where, { most = 6 } = {}) {
  let found = await glyphs(page, where);
  const count = await page.evaluate(([src]) => { const actionOf = (0, eval)(src);
    const all = (root, s, out = []) => { out.push(...root.querySelectorAll(s)); for (const n of root.querySelectorAll("*")) if (n.shadowRoot) all(n.shadowRoot, s, out); return out; };
    window.__moreButtons = all(document, "button").filter((b) => actionOf(b.getAttribute("aria-label") || b.getAttribute("title") || "") === "more" && !b.closest('[role="menu"]'));
    return window.__moreButtons.length; }, [ACTION_OF]);
  for (let i = 0; i < Math.min(count, most); i++) {
    const ok = await page.evaluate((n) => { const b = window.__moreButtons[n]; if (!b || !b.isConnected) return false; b.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true })); b.click(); return true; }, i).catch(() => false);
    if (!ok) continue;
    await page.waitForTimeout(150);
    found = found.concat(await glyphs(page, `${where} (a More menu)`));
    await page.keyboard.press("Escape").catch(() => {}); await page.waitForTimeout(60);
  }
  return found;
}

// ---- 2b: a file card's menu in a chat (media/shared/filemenu.js), the same on Work, ChatDGC and a Pip's chat --------
export const FILE_ROWS = ["Open", "Open in editor", "Save a copy…", "Copy", "Copy path", "Reveal in file manager"];
export const KEPT_WHY = "DGC keeps this copy for the chat: Save a copy… to put it where you want";
const DEEP_ALL = "const all = (root, s, out = []) => { out.push(...root.querySelectorAll(s)); for (const n of root.querySelectorAll('*')) if (n.shadowRoot) all(n.shadowRoot, s, out); return out; };";
/** Every file card on the page (through a side bar's shadow root too): its name, its side, and its ⋯. */
export const fileCards = (page) => page.evaluate((deep) => { const all = new Function(`${deep} return all;`)();
  return all(document, "[data-file-card]").filter((c) => c.getClientRects().length).map((c) => { const more = c.querySelector(".dgc-file-more"), r = more?.getBoundingClientRect(), s = more ? getComputedStyle(more) : null;
    return { name: c.dataset.fileName || "", side: c.dataset.fileSide || "", more: !!more, label: more?.getAttribute("aria-label") || "", popup: more?.getAttribute("aria-haspopup") || "",
      shown: !!more && r.width >= 20 && r.height >= 20 && s.visibility !== "hidden" && Number(s.opacity) > 0.3, tab: more ? more.tabIndex : -1, radius: s ? s.borderTopLeftRadius : "", box: more ? [Math.round(r.width), Math.round(r.height)] : [] }; }); }, DEEP_ALL);
/** The open menu's rows: each one's words, whether it is off, and why. */
export const menuRows = (page) => page.evaluate(() => [...document.querySelectorAll(".dgc-menu.dgc-pop .dgc-menu-row")].map((r) => ({ label: r.textContent.trim(), off: r.getAttribute("aria-disabled") === "true" || r.disabled, why: r.getAttribute("title") || "" })));
const cardDo = (page, name, what) => page.evaluate(([deep, name, what]) => { const all = new Function(`${deep} return all;`)();
  const card = all(document, "[data-file-card]").find((c) => c.dataset.fileName === name && c.getClientRects().length); if (!card) return "no card";
  const more = card.querySelector(".dgc-file-more"); if (!more) return "no more";
  const r = more.getBoundingClientRect();
  if (what === "where") return { x: r.left + r.width / 2, y: r.top + r.height / 2, cx: card.getBoundingClientRect().left + 14, cy: card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2 };
  if (what === "focus") { more.focus(); return "ok"; }
  if (what === "focused") { let a = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement; return a === more; }
  if (what === "expanded") return more.getAttribute("aria-expanded");
  return ""; }, [DEEP_ALL, name, what]);
/** Opens a card's menu as a person does: "click" its ⋯, "right" a right-click on the card, "keys" Shift+F10 with the ⋯ focused. */
export async function openFileMenu(page, name, how = "click") {
  await page.keyboard.press("Escape").catch(() => {}); await page.waitForTimeout(40);
  const at = await cardDo(page, name, "where");
  if (typeof at === "string") throw new Error(`${name}: ${at}`);
  if (how === "click") await page.mouse.click(at.x, at.y);
  else if (how === "right") await page.mouse.click(at.cx, at.cy, { button: "right" });
  else { await cardDo(page, name, "focus"); await page.keyboard.press("Shift+F10"); }
  await page.waitForTimeout(120);
  return menuRows(page);
}
export const fileMoreFocused = (page, name) => cardDo(page, name, "focused");
/** Choose a row of the open menu by its words (a row that is off chooses nothing). */
export async function pickRow(page, label) { await page.evaluate((l) => [...document.querySelectorAll(".dgc-menu.dgc-pop .dgc-menu-row")].find((r) => r.textContent.trim() === l)?.click(), label); await page.waitForTimeout(80); }

/** A Work session where you attached a project file and a picture, and the turn made two files (a CSV and a video). */
export async function openWorkFiles(browser, { width = 440, height = 760, theme = "dark-modern" } = {}) {
  const { openWork } = await import("./uir2a-scene.mjs");
  const x = await openWork(browser, { width, height, theme, turns: 0, capabilities: { produced_files: true } });
  await x.send({ type: "attach", label: "billing/totals.py", resource: { type: "file_mention", uri: "file:///home/me/projects/uploads-service/billing/totals.py", path: "/home/me/projects/uploads-service/billing/totals.py", relative_path: "billing/totals.py", workspace: "uploads-service" } });
  await x.page.evaluate(async () => { const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360; const g = canvas.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 640, 360); grad.addColorStop(0, "#2f6f8f"); grad.addColorStop(1, "#e9b44c"); g.fillStyle = grad; g.fillRect(0, 0, 640, 360);
    const blob = await new Promise((done) => canvas.toBlob(done, "image/png")); const data = new DataTransfer(); data.items.add(new File([blob], "invoice-shot.png", { type: "image/png" }));
    document.getElementById("input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); });
  await x.page.waitForFunction(() => !!document.querySelector("#attachments .image-att-chip img"));
  const id = await x.say("Do these totals match? Write a CSV.");      // (short: a long prompt folds, and what the fold hides leaves the tab order)
  await x.event({ type: "prompt_accepted", request_id: id, state: "started" }); await x.event({ type: "turn_start", turn_id: "tf", prompt: "" });
  await x.event({ type: "tool_call", call_id: "cf", name: "bash", args: { command: "python tools/compare.py" }, summary: "python tools/compare.py" });
  await x.event({ type: "tool_result", call_id: "cf", name: "bash", output: "wrote out/differences.csv", is_error: false, is_diff: false, diff: "" });
  await x.event({ type: "files_ready", call_id: "cf", items: [{ name: "differences.csv", rel: "out/differences.csv", bytes: 2380 }, { name: "walkthrough.mp4", rel: "out/walkthrough.mp4", bytes: 6 * 1048576 }] });
  await x.event({ type: "text_delta", text: "Two rows differ: both are rounding. The list is in the CSV." }); await x.event({ type: "stream_end", message_id: "tf:1", phase: "final" });
  await x.event({ type: "turn_end", turn_id: "tf", reason: "completed", final_message_id: "tf:1", usage: {} });
  await x.page.waitForTimeout(300);
  // (In a narrow side bar the two chips fold the prompt: opened, as a person reading its files has it.)
  await x.page.evaluate(() => document.querySelector('#log .msg.user .bubble[data-fold="folded"] .prompt-fold')?.click()); await x.page.waitForTimeout(150);
  return x;
}
export const ATT = (c) => `att_${c.repeat(32)}`;
/** A ChatDGC chat where you attached a file and a picture, and the reply made a Word file and a Markdown file. */
export async function openChatFiles(browser, { width = 440, height = 760, theme = "dark-modern" } = {}) {
  const x = await chat.openChat(browser, { width, height, theme });
  x.page.setDefaultTimeout(8000);
  const at = "2026-11-10T09:30:00Z";
  await x.send({ type: "opened", conversation: chat.conversation({ title: "Rent or buy: the numbers" }), earlier: 0, busy: false, messages: [
    { id: chat.M(1), role: "user", text: "Here is the lease and my notes. Write it up as a report.", created_at: at, attachments: [{ id: ATT("a"), kind: "file", name: "lease.pdf", size: 482133 }, { id: ATT("b"), kind: "file", name: "my-notes.txt", size: 1820 }] },
    { id: chat.M(2), role: "assistant", text: "The report is ready, with the numbers as a Markdown table beside it.", created_at: at, finish: "stop", model: "qwen3.8:27b",
      files: [{ id: ATT("c"), name: "rent-or-buy.docx", format: "docx", kind: "file", size: 38400, pages: 3 }, { id: ATT("d"), name: "numbers.md", format: "md", kind: "file", size: 2210 }] }] });
  await x.send({ type: "models", ids: ["qwen3.8:27b"], current: "qwen3.8:27b" });
  await x.page.waitForTimeout(250);
  return x;
}

// ---- 2d: inline touches (media/shared/inline.js) in what you type and what you read, on Work, ChatDGC and a Pip's chat ----
export const INLINE_REPLY = ["The accent is #7c5cff on `#1f1f1f`, with rgb(255, 120, 0) for warnings and `hsl(210 50% 40%)` for links.",
  "Open the palette with Ctrl+Shift+P, or `⌘K` then `F5`; Alt+Enter queues. Enter the value and press on.",
  "The release call is 09:00 UTC (3pm PST is the fallback); lunch at 12:30 is not a meeting.",
  "Not colours: issue #123, https://example.com/page#fff and build abc#fff123x.",
  "Call `GET /api/orders` or `/v1/users/{id}`; ordinary code is `npm test`.",
  "```css\n.a { color: #ff0000; }\n```"].join("\n\n");
export const INLINE_GIT = "Fixed in a1b2c3d (not in 9f8e7d6c), see #123 and acme/shop#45. The colour is #0a0b0c.";
const IL_DEEP = "const all = (root, s, out = []) => { out.push(...root.querySelectorAll(s)); for (const n of root.querySelectorAll('*')) if (n.shadowRoot) all(n.shadowRoot, s, out); return out; };";
/** What the inline touches drew inside `scope` (a selector for message bodies; "" for the whole page), through shadow roots. */
export const inlineRead = (page, scope = "") => page.evaluate(([sel, deep]) => { const all = new Function(`${deep} return all;`)();
  const inScope = (n) => !sel || all(document, sel).some((s) => s.contains(n)), seen = (n) => n.getClientRects().length > 0;
  const pick = (q) => all(document, q).filter((n) => inScope(n) && seen(n));
  const box = (n) => { const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  return { swatches: pick(".dgc-il-sw").map((n) => ({ code: n.dataset.colour, ground: getComputedStyle(n).backgroundColor, name: n.getAttribute("aria-label") || "", title: n.getAttribute("title") || n.dataset.tip || "", inPre: !!n.closest("pre"), tag: n.tagName, ...box(n) })),
    keys: pick(".dgc-il-keys").map((n) => ({ as: n.dataset.as, caps: [...n.querySelectorAll("kbd")].map((k) => k.textContent), radius: getComputedStyle(n.querySelector("kbd")).borderTopLeftRadius })),
    times: pick(".dgc-il-time").map((n) => ({ text: n.textContent, title: n.getAttribute("title") || n.dataset.tip || "", line: getComputedStyle(n).textDecorationLine })),
    commits: pick(".dgc-il-commit").map((n) => ({ hash: n.dataset.hash, tag: n.tagName, text: n.textContent })),
    issues: pick(".dgc-il-issue").map((n) => ({ text: n.textContent.trim(), href: n.getAttribute("href") || n.dataset.href || "" })),
    apis: pick(".dgc-il-copy").map((n) => n.dataset.copy), copied: pick(".dgc-il-copied").length }; }, [scope, IL_DEEP]);
/** Anything the inline touches drew in or over a prompt box (his call, 16 Nov: the box is never decorated). */
export const boxDecorations = (page, boxSel) => page.evaluate(([sel, deep]) => { const all = new Function(`${deep} return all;`)(), box = all(document, sel)[0], b = box.getBoundingClientRect();
  return all(document, "[class*='dgc-il']").filter((n) => n.getClientRects().length).filter((n) => { const r = n.getBoundingClientRect();
    return box.contains(n) || (r.right > b.left && r.left < b.right && r.bottom > b.top && r.top < b.bottom); }).map((n) => n.className); }, [boxSel, IL_DEEP]);
/** Click something the inline touches drew (through a shadow root), by selector and index. */
export const inlineClick = (page, selector, n = 0, opts = {}) => page.evaluate(([sel, i, deep, o]) => { const all = new Function(`${deep} return all;`)(), node = all(document, sel).filter((x) => x.getClientRects().length && !x.closest(".dgc-il-layer"))[i];
  node.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, ...o })); return true; }, [selector, n, IL_DEEP, opts]);
