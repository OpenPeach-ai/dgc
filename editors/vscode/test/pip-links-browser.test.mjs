// Links in a Pip's chat, as in Work's (15 Nov: "URL pasting in pip's prompt box, should work like how it does on work
// session prompt box"). In the real page, in real Chromium, in the side bar (a shadow root in Work's page) and in a tab:
// one pasted link is a pill and the Pip is sent the link itself; a paragraph with a link in it stays text; a sent
// message's links are links with their site's favicon, and the bundled mark when that icon cannot load; a reply's links
// the same. With dgc.linkFavicons off no icon is asked for, and the tab's own policy would not let one load.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { PIP, openChat, openTabPage } from "./support/pip-chat-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const LINK = "https://vibedgc.com/pricing?ref=chat";
const PROSE = "Compare https://vibedgc.com/pricing with what we pay now, then tell me.";
const SAID = [{ role: "user", text: "Read https://vibedgc.com/pricing?ref=chat and https://github.com/openai/codex." },
  { role: "assistant", text: "Both read: [the pricing page](https://vibedgc.com/pricing?ref=chat) and [the repository](https://github.com/openai/codex)." }];
const ICON = (origin) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(origin)}&sz=32`;

const paste = (p, text) => p.evaluate((words) => {
  const root = window.__pipsRoot || document, box = root.querySelector("#chatText");
  box.focus();
  const data = new DataTransfer(); data.setData("text/plain", words);
  box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true }));
}, text);
const box = (p) => p.evaluate(() => {
  const root = window.__pipsRoot || document, el = root.querySelector("#chatText");
  return { text: el.value, pills: [...el.querySelectorAll("[data-pill]")].map((n) => ({ kind: n.dataset.kind, wire: n.dataset.pill, shown: n.textContent, title: n.title, imgs: n.querySelectorAll("img").length,
    radius: parseFloat(getComputedStyle(n).borderTopLeftRadius), height: Math.round(n.getBoundingClientRect().height) })) };
});
const links = (p, within) => p.evaluate((sel) => [...(window.__pipsRoot || document).querySelectorAll(`${sel} .md-link`)].map((a) => {
  const img = a.querySelector("img.link-favicon");
  return { target: a.dataset.target, kind: a.dataset.linkKind, words: a.textContent, prompt: a.classList.contains("prompt-link"), src: img?.getAttribute("src") || null,
    drew: !!img && img.complete && img.naturalWidth > 0, mark: a.dataset.linkSource || null, fallback: a.dataset.linkFallback || null };
}), within);
const SENT = ".pip-message.user", REPLY = ".pip-message.assistant";
const open = (o) => openChat(browser, { height: 760, api: 97, convs: true, switches: true, codicon: true, ...o });

for (const [where, width] of [["side", 300], ["tab", 700]]) {
  test(`one pasted link is a pill in a Pip's box, and the Pip is sent the link itself (${where === "side" ? "side bar" : "tab"}, ${width} px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ where, width, icons: "answer" });
    try {
      const asked = x.asked, already = asked.length;   // (the chat's earlier reply has a link: its site's icon)
      await paste(x.p, LINK);
      const held = await box(x.p);
      assert.equal(held.pills.length, 1, "the link is one pill");
      assert.deepEqual({ kind: held.pills[0].kind, wire: held.pills[0].wire, shown: held.pills[0].shown, title: held.pills[0].title },
        { kind: "link", wire: LINK, shown: "vibedgc.com/pricing", title: LINK }, "its site and path are what it shows; what goes is the link, whole");
      assert.equal(held.text, LINK, "the box's words are the link");
      assert.equal(held.pills[0].imgs, 0, "no icon in the box: nothing is asked for a link you have not sent");
      assert.ok(held.pills[0].radius > 0 && held.pills[0].radius <= 8, `the pill's corners are the 6 px family (${held.pills[0].radius})`);
      await x.p.waitForTimeout(200);
      assert.equal(asked.length, already, "pasting asks the icon service nothing");
      assert.ok(asked.every((u) => !/vibedgc/.test(u)), "least of all about the link in the box");
      await x.p.evaluate(() => (window.__pipsRoot || document).querySelector("#chat-form .chat-send").click());
      await x.p.waitForFunction(() => (window.__sent || []).some((r) => r.type === "send_pip_message"));
      const sent = await x.p.evaluate(() => window.__sent.find((r) => r.type === "send_pip_message"));
      assert.equal(sent.text, LINK, "the Pip receives the link, character for character");
      assert.equal("display_mentions" in sent, false, "a link is words, never a display mark DGC might refuse");
      // Sent, it is a link with its site's favicon.
      await x.p.waitForFunction((sel) => [...(window.__pipsRoot || document).querySelectorAll(`${sel} .md-link.prompt-link`)].at(-1)?.querySelector("img.link-favicon")?.naturalWidth > 0, SENT, { timeout: 5000 });
      const shown = (await links(x.p, SENT)).at(-1);
      assert.deepEqual({ target: shown.target, kind: shown.kind, words: shown.words, prompt: shown.prompt, src: shown.src, mark: shown.mark },
        { target: LINK, kind: "external", words: LINK, prompt: true, src: ICON("https://vibedgc.com"), mark: null });
      assert.ok(asked.includes(ICON("https://vibedgc.com")) && asked.every((u) => !/pricing|ref=chat/.test(u)), "sent, its site is asked about, never the path or the query");
      // And it opens through the one route out: the host is asked, with the link.
      await x.p.evaluate((sel) => [...(window.__pipsRoot || document).querySelectorAll(`${sel} .md-link`)].at(-1).click(), SENT);
      const opened = await x.p.evaluate(() => (window.__posted || []).filter((m) => m.type === "openExternal").map((m) => m.url));
      assert.deepEqual(opened, [LINK]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`a paragraph with a link in it stays text in a Pip's box (${where === "side" ? "side bar" : "tab"}, ${width} px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ where, width });
    try {
      await paste(x.p, PROSE);
      const held = await box(x.p);
      assert.deepEqual(held.pills, [], "prose is prose: no part of it becomes a pill");
      assert.equal(held.text, PROSE);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`a sent message's links and a reply's links wear their favicons (${where === "side" ? "side bar" : "tab"}, ${width} px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ where, width, convs: false, said: SAID, icons: "answer" });
    try {
      const asked = x.asked;
      await x.p.evaluate(() => window.postMessage({ type: "pipsUnreadChanged" }, "*"));   // (a redraw after the service answers)
      await x.p.waitForFunction(([a, b]) => [a, b].every((sel) => { const all = [...(window.__pipsRoot || document).querySelectorAll(`${sel} .md-link[data-link-kind=external] img.link-favicon`)]; return all.length >= 2 && all.every((i) => i.naturalWidth > 0); }), [SENT, REPLY], { timeout: 6000 });
      const sent = (await links(x.p, SENT)).filter((a) => a.prompt);
      assert.deepEqual(sent.map((a) => [a.target, a.src, a.mark]), [["https://vibedgc.com/pricing?ref=chat", ICON("https://vibedgc.com"), null], ["https://github.com/openai/codex", ICON("https://github.com"), null]]);
      assert.equal(await x.p.evaluate((sel) => [...(window.__pipsRoot || document).querySelectorAll(`${sel} .prompt-text`)].at(-1).textContent, SENT), SAID[0].text, "the message reads as it was typed, its full stop outside the link");
      const reply = (await links(x.p, REPLY)).filter((a) => /vibedgc|github/.test(a.target));
      assert.deepEqual(reply.map((a) => [a.src, a.drew]), [[ICON("https://vibedgc.com"), true], [ICON("https://github.com"), true]]);
      // A favicon is the size of its words, never the icon service's 32 px.
      const sizes = await x.p.evaluate(() => [...(window.__pipsRoot || document).querySelectorAll(".md-link img.link-favicon")].map((i) => { const b = i.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; }));
      assert.ok(sizes.length >= 4 && sizes.every(([w, h]) => w === h && w >= 12 && w <= 16), `each is a small square beside its words: ${JSON.stringify(sizes)}`);
      assert.ok(asked.every((u) => /^https:\/\/www\.google\.com\/s2\/favicons\?domain=https%3A%2F%2F(vibedgc\.com|github\.com|news\.example)&sz=32$/.test(u)), `only sites are asked about: ${asked}`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`a favicon that cannot load is the bundled mark, and is not asked for again on every redraw (${where === "side" ? "side bar" : "tab"}, ${width} px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ where, width, convs: false, said: SAID, icons: "refuse" });
    try {
      const asked = x.asked;
      await x.p.evaluate(() => window.postMessage({ type: "pipsUnreadChanged" }, "*"));
      await x.p.waitForFunction(() => { const all = [...(window.__pipsRoot || document).querySelectorAll(".pip-message .md-link[data-link-kind=external]")]; return all.length >= 4 && all.every((a) => !a.querySelector("img") && a.dataset.linkSource); }, null, { timeout: 6000 });
      const sent = (await links(x.p, SENT)).filter((a) => a.prompt), reply = (await links(x.p, REPLY)).filter((a) => /vibedgc|github/.test(a.target));
      assert.deepEqual(sent.map((a) => [a.mark, a.fallback]), [["dgc", null], ["github", null]], "a sent link's own mark comes back");
      assert.deepEqual(reply.map((a) => [a.mark, a.fallback]), [["dgc", null], ["github", null]], "a reply link's too");
      // The mark is drawn: a glyph from the editor's icon font before the words.
      const glyph = await x.p.evaluate(() => { const a = (window.__pipsRoot || document).querySelector(".pip-message.user .md-link[data-link-source]"), s = getComputedStyle(a, "::before"); return { family: s.fontFamily, content: s.content, width: parseFloat(s.width) }; });
      assert.match(glyph.family, /codicon/);
      assert.ok(glyph.content && glyph.content !== "none" && glyph.width > 0, `the mark has a glyph: ${JSON.stringify(glyph)}`);
      // His look (15 Nov): a purple GitHub mark read as a brand logo in the wrong colour. A site's stand-in mark is the
      // muted grey; only DGC's own mark is in the link's colour.
      const tint = await x.p.evaluate(() => {
        const root = window.__pipsRoot || document;
        const link = (source) => root.querySelector(`.pip-message.user .md-link[data-link-source="${source}"]`);
        const host = link("github").closest(".pip-message");
        const mark = (source) => getComputedStyle(link(source), "::before").color;
        const probe = (name) => { const s = document.createElement("span"); s.style.color = `var(${name})`; host.appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c; };
        return { github: mark("github"), dgc: mark("dgc"), muted: probe("--muted"), link: probe("--link") };
      });
      assert.equal(tint.github, tint.muted, `a site's mark is grey: ${JSON.stringify(tint)}`);
      assert.notEqual(tint.github, tint.link);
      assert.equal(tint.dgc, tint.link, "DGC's own mark keeps the link's colour");
      // The page redraws all the time (every word typed, every look for news): the icons that failed are not asked for again.
      const before = asked.length;
      for (const words of ["a", "ab", "abc"]) { await x.p.evaluate((w) => { const b = (window.__pipsRoot || document).querySelector("#chatText"); b.focus(); document.execCommand("insertText", false, w.slice(-1)); }, words); await x.p.waitForTimeout(120); }
      await x.p.evaluate(() => window.postMessage({ type: "pipsUnreadChanged" }, "*")); await x.p.waitForTimeout(400);
      assert.equal(asked.length, before, `no icon is asked for again (${asked.length - before} more requests)`);
      assert.equal((await links(x.p, SENT)).filter((a) => a.prompt).every((a) => a.mark && !a.src), true, "and the marks stay");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`with dgc.linkFavicons off a Pip's chat asks for no icon (${where === "side" ? "side bar" : "tab"}, ${width} px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ where, width, convs: false, said: SAID, favicons: "off", icons: "answer" });
    try {
      const asked = x.asked;
      await x.p.evaluate(() => window.postMessage({ type: "pipsUnreadChanged" }, "*")); await x.p.waitForTimeout(500);
      const all = [...await links(x.p, SENT), ...await links(x.p, REPLY)].filter((a) => a.kind === "external");
      assert.ok(all.length >= 4);
      assert.ok(all.every((a) => a.src === null && a.mark), `every link is its bundled mark: ${JSON.stringify(all.map((a) => [a.src, a.mark]))}`);
      assert.equal(await x.p.evaluate(() => (window.__pipsRoot || document).querySelectorAll("img.link-favicon").length), 0, "there is no favicon <img> on the page");
      assert.deepEqual(asked, [], "nothing leaves the machine for an icon");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// The tab's own document, with the Content-Security-Policy src/pipsView.ts writes.
const imgSrc = (html) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)[1].split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src")) || "";

test("the Pips tab lets a favicon load only while dgc.linkFavicons is on (its own policy, in its own document)", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openTabPage(browser, { width: 700, api: 97, said: SAID, favicons: true, icons: "answer" });
  try {
    const asked = x.asked;
    assert.match(imgSrc(x.html), /^img-src https:\/\/pips\.test data: https:$/, "on: the policy lets an https image in, as Work's does");
    assert.match(x.html, /<body[^>]* data-link-favicons="on"/);
    await x.p.evaluate(() => window.postMessage({ type: "pipsUnreadChanged" }, "*"));
    await x.p.waitForFunction(() => { const all = [...document.querySelectorAll(".pip-message .md-link[data-link-kind=external] img.link-favicon")]; return all.length >= 4 && all.every((i) => i.naturalWidth > 0); }, null, { timeout: 6000 });
    assert.ok(asked.length >= 2, "the icons were asked for, and drew");
    assert.deepEqual((await x.blocked()).filter((b) => b.startsWith("img-src")), [], "and the policy refused none of them");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("off: no https: in the Pips tab's policy, no favicon <img>, no request; and the policy alone would refuse one", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openTabPage(browser, { width: 700, api: 97, said: SAID, favicons: false, icons: "answer" });
  try {
    const asked = x.asked;
    assert.equal(imgSrc(x.html), "img-src https://pips.test data:", "off: the editor's own origin and data: only");
    assert.doesNotMatch(imgSrc(x.html), /https:(\s|$)/);
    assert.match(x.html, /<body[^>]* data-link-favicons="off"/);
    await x.p.evaluate(() => window.postMessage({ type: "pipsUnreadChanged" }, "*")); await x.p.waitForTimeout(500);
    assert.equal(await x.p.evaluate(() => document.querySelectorAll("img.link-favicon").length), 0, "no favicon <img> is drawn");
    const marks = await x.p.evaluate(() => [...document.querySelectorAll(".pip-message .md-link[data-link-kind=external]")].map((a) => a.dataset.linkSource || null));
    assert.ok(marks.length >= 4 && marks.every(Boolean), `every link is its bundled mark: ${marks}`);
    assert.deepEqual(asked, []);
    // Were an icon drawn anyway, the page's policy stops it before it leaves.
    await x.p.evaluate(() => { const img = new Image(); img.src = "https://www.google.com/s2/favicons?domain=https%3A%2F%2Fvibedgc.com&sz=32"; document.body.append(img); });
    await x.p.waitForFunction(() => (window.__blocked || []).some((b) => b.startsWith("img-src")), null, { timeout: 4000 });
    assert.deepEqual(asked, [], "the request never left");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a link pill comes back as a pill when a message is given back to the box, and a copied one pastes as a pill", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where: "tab", width: 700 });
  try {
    await x.p.evaluate(() => { const b = (window.__pipsRoot || document).querySelector("#chatText"); b.focus(); document.execCommand("insertText", false, "Read "); });
    await paste(x.p, LINK);
    const held = await box(x.p);
    assert.equal(held.text, `Read ${LINK}`);
    assert.equal(held.pills.length, 1);
    // Select all, cut, paste: the pill is a pill again (the box's own memory of its last copy).
    await x.p.keyboard.press("Control+A");
    const cut = await x.p.evaluate(() => { const b = (window.__pipsRoot || document).querySelector("#chatText"); const data = new DataTransfer();
      b.dispatchEvent(new ClipboardEvent("cut", { clipboardData: data, bubbles: true, cancelable: true, composed: true })); return data.getData("text/plain"); });
    assert.equal(cut, `Read ${LINK}`, "on the clipboard it is the link itself");
    assert.equal((await box(x.p)).text, "");
    await paste(x.p, cut);
    const back = await box(x.p);
    assert.equal(back.text, `Read ${LINK}`);
    assert.deepEqual(back.pills.map((n) => [n.kind, n.wire]), [["link", LINK]]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
