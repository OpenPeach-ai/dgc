// ChatDGC's header wears DGC's wordmark as Work's header does (src/panel.ts, `#phead .pm`): a mark, "DGC" and a
// blinking cursor. Its mark is ChatDGC's own, the chat bubble with the three slashes inside it (the tab's icon,
// media/chatdgc-tab-*.svg), drawn inline so the slashes can breathe as Work's do. Here, in jsdom: the screen as
// src/chatdgc.ts serves it and as it stays once its script runs, and the stylesheet rules that move it. That it
// really moves, and stops for reduced motion, is checked in Chromium (chatdgc-screen.test.mjs).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");
const windows = [];
after(() => { for (const w of windows) w.close(); });

const chatSource = read("src/chatdgc.ts");
const chatPage = chatSource.match(/return `(<!doctype html>[\s\S]*?<\/html>)`;/)[1];
const workPage = [...read("src/panel.ts").matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map((m) => m[0])
  .find((page) => page.includes('id="input"'));
const bare = (html) => html.replace(/<link [^>]*>/g, "").replace(/<script [^>]*><\/script>/g, "").replace(/\$\{[^}]*\}/g, "");
const svg = (file) => new JSDOM(read(file), { contentType: "image/svg+xml" }).window.document.documentElement;
const ID = `chat_${"a".repeat(32)}`, P = `proj_${"c".repeat(32)}`;

/** ChatDGC's screen with its own scripts run, as the tab loads them. */
function chatScreen() {
  const scripts = [...chatPage.matchAll(/asset\("media\/([\w-]+\.js)"\)/g)].map((m) => m[1]);
  assert.equal(scripts.at(-1), "chatdgc.js");
  const dom = new JSDOM(bare(chatPage), { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  w.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
  w.eval(buildSync({ entryPoints: [join(root, "src/markdown.ts")], bundle: true, format: "iife", globalName: "DgcMarkdown",
    write: false, platform: "browser" }).outputFiles[0].text + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
  w.eval(scripts.map((file) => read(`media/${file}`)).join("\n"));
  return { d: w.document, send: (data) => w.dispatchEvent(new w.MessageEvent("message", { data })) };
}
/** What a wordmark is made of, in order: its elements by tag and class, and its words. */
const parts = (pm) => [...pm.childNodes].map((n) => (n.nodeType === 3 ? n.textContent : `${n.localName}.${n.getAttribute("class")}`));

test("ChatDGC's header opens on DGC's wordmark with its own mark: the tab icon's bubble and slashes, then DGC and the cursor", () => {
  const { d, send } = chatScreen();
  const head = d.querySelector(".cd-head"), pm = head.firstElementChild;
  assert.ok(pm?.matches(".pm"), "the wordmark comes first in the header, where Work's does");
  const work = new JSDOM(bare(workPage)).window.document.querySelector("#phead .pm");
  assert.deepEqual(parts(work), ["svg.mk", "DGC", "span.cur"], "Work's: the mark, DGC, the cursor");
  assert.deepEqual(parts(pm), ["svg.mk mk-chat", "DGC", "span.cur"], "ChatDGC's: the same, with its own mark");
  assert.equal(pm.querySelector(".cur").getAttribute("aria-hidden"), "true");

  // The mark is the tab's icon, path for path: the bubble, and the three slashes inside it as DGC's own icon draws them.
  const mark = pm.querySelector("svg.mk"), icon = svg("media/chatdgc-tab-dark.svg"), dgc = svg("media/dgc-tab-dark.svg");
  assert.equal(mark.getAttribute("aria-hidden"), "true", "the words beside it name it");
  assert.equal(mark.getAttribute("viewBox"), icon.getAttribute("viewBox"));
  const bubble = mark.querySelector(".mk-bubble"), slashes = mark.querySelector(".mk-slashes");
  assert.equal(bubble.getAttribute("d"), icon.querySelector(":scope > path").getAttribute("d"));
  assert.deepEqual(["fill", "stroke", "stroke-width"].map((a) => bubble.getAttribute(a)), ["none", "currentColor", "1.6"],
                   "an outline in the mark's colour, as heavy as the icon's");
  assert.equal(slashes.getAttribute("transform"), icon.querySelector("g").getAttribute("transform"));
  assert.equal(slashes.getAttribute("fill"), "currentColor");
  const ds = (nodes) => [...nodes].map((n) => n.getAttribute("d"));
  assert.deepEqual(ds(slashes.children), ds(icon.querySelectorAll("g > path")));
  assert.deepEqual(ds(slashes.children), ds(dgc.querySelectorAll("path")), "DGC's three slashes, as its own icon has them");
  assert.ok([...slashes.children].every((n) => n.localName === "path"), "each slash its own element, so each can breathe in turn");

  // It stays through what the screen does to its header: a project's name before the title, a rename.
  send({ type: "opened", conversation: { id: ID, title: "Where we stay", project: P, temporary: false }, messages: [], earlier: 0, busy: false,
         project: { id: P, name: "Goa trip", color: "teal", instructions: "", memory: "shared", chats: 1, files: [] } });
  send({ type: "projects", projects: [{ id: P, name: "Goa trip", color: "teal", instructions: "", memory: "shared", chats: 1, files: [] }] });
  send({ type: "changed", summary: { title: "Where we stay in Goa" } });
  assert.equal(head.firstElementChild, pm, "the same element, still first");
  assert.equal(pm.compareDocumentPosition(d.getElementById("cd-crumb")) & 4, 4, "before the project");
  assert.equal(pm.compareDocumentPosition(d.getElementById("cd-title")) & 4, 4, "and the title");
  assert.equal(d.getElementById("cd-title").contains(pm), false, "the chat's heading is its title alone");
  assert.equal(pm.querySelectorAll(".mk-slashes > path").length, 3);
});

test("the slashes and the cursor move by Work's own rules, the bubble holds still, and reduced motion stops them with Work's", () => {
  const dom = new JSDOM(`<style>${read("media/main.css").replace(/@import[^;]*;/, "")}</style><style>${read("media/chatdgc.css")}</style>`);
  windows.push(dom.window);
  const [main, own] = dom.window.document.styleSheets;
  const flat = (rules, media = "") => [...rules].flatMap((r) => (r.cssRules && r.media ? flat(r.cssRules, r.media.mediaText) : r.selectorText
    ? [{ media, selectors: r.selectorText.split(",").map((s) => s.trim()), style: r.style }] : []));
  const rules = flat(main.cssRules);
  /** The rules (outside any @media unless one is named) that name both selectors in one list: one rule for both headers. */
  const shared = (work, chat, media = "") => rules.filter((r) => r.media === media && r.selectors.includes(work) && r.selectors.includes(chat));
  const one = (work, chat, media) => {
    const found = shared(work, chat, media);
    assert.equal(found.length, 1, `one rule names both ${work} and ${chat}${media ? ` in @media ${media}` : ""}`);
    return found[0].style;
  };
  assert.equal(one("#phead .pm svg.mk path", ".cd-head .pm .mk-slashes path").getPropertyValue("animation"),
               "brand-slash-pulse 2.1s ease-in-out infinite", "the slashes breathe as Work's do");
  assert.equal(one("#phead .pm svg.mk path:nth-child(2)", ".cd-head .pm .mk-slashes path:nth-child(2)").getPropertyValue("animation-delay"), "0.22s");
  assert.equal(one("#phead .pm svg.mk path:nth-child(3)", ".cd-head .pm .mk-slashes path:nth-child(3)").getPropertyValue("animation-delay"), "0.44s");
  assert.match(one("#phead .pm .cur", ".cd-head .pm .cur").getPropertyValue("animation"), /^blink 1\.1s step-end infinite$/, "the cursor blinks as Work's does");
  for (const [work, chat] of [["#phead .pm", ".cd-head .pm"], ["#phead .pm svg.mk", ".cd-head .pm svg.mk"]]) one(work, chat);
  const still = "(prefers-reduced-motion: reduce)";
  assert.equal(one("#phead .pm svg.mk path", ".cd-head .pm .mk-slashes path", still).getPropertyValue("animation"), "none");
  assert.equal(one("#phead .pm .cur", ".cd-head .pm .cur", still).getPropertyValue("animation"), "none");
  // Nothing copied, nothing extra: ChatDGC's stylesheet animates no part of the wordmark, and nothing moves the bubble.
  for (const r of flat(own.cssRules)) {
    if (r.selectors.some((s) => /\.pm\b|\.mk-/.test(s))) assert.equal(r.style.getPropertyValue("animation") + r.style.getPropertyValue("animation-name"), "", r.selectors.join(", "));
  }
  assert.doesNotMatch(read("media/chatdgc.css"), /brand-slash-pulse|@keyframes blink\b/);
  assert.equal(rules.filter((r) => r.selectors.some((s) => /mk-bubble/.test(s))).length, 0, "the bubble holds still");
});
