// Links and "Open in editor" in a Pip's chat as the side bar really holds it: Work's own page (media/main.js and its
// style sheets) with the Pips view mounted in its shadow root, in real Chromium. What the tab's page does on its own
// goes through Work's page here: its paste handler is the shared box's, its link marks come from the Pips bundle into
// the shadow root, a failed favicon is caught inside that root, and what the host tells the Pips page (a draft typed
// in the chat's editor tab, that the chat changed there) has to be passed on to it by Work's page.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { GST, openOnePips } from "./support/one-pips-scene.mjs";

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

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHUlEQVR4nGMsC/n2n4ECwESJ5lEDRg0YNWAwGQAAZakC32PgnS0AAAAASUVORK5CYII=", "base64");
const LINK = "https://vibedgc.com/pricing?ref=chat";
const open = async ({ width = 300, theme = "dark-modern", icons = "answer" } = {}) => {
  const x = await openOnePips(browser, { api: 97, width, height: 820, theme, faces: true, scene: { sub: true, waiting: false, fix: "none" } });
  const asked = [];
  await x.page.context().route("https://www.google.com/**", (route) => { asked.push(route.request().url()); return icons === "answer" ? route.fulfill({ contentType: "image/png", body: PNG }) : route.abort(); });
  await x.openPip(GST);
  return { ...x, asked };
};
const paste = (x, text) => x.inPips((root, words) => { const box = root.querySelector("#chatText"); box.focus(); const data = new DataTransfer(); data.setData("text/plain", words);
  box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true })); }, text);
const box = (x) => x.inPips((root) => { const el = root.querySelector("#chatText"); return { text: el.value, pills: [...el.querySelectorAll("[data-pill]")].map((n) => [n.dataset.kind, n.dataset.pill, n.textContent]) }; });

for (const [width, theme] of [[300, "dark-modern"], [440, "light-modern"]]) {
  test(`in the side bar: one pasted link is a pill, the Pip is sent the link, and its bubble is a link with its favicon (${width} px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ width, theme });
    try {
      await paste(x, LINK);
      assert.deepEqual(await box(x), { text: LINK, pills: [["link", LINK, "vibedgc.com/pricing"]] });
      assert.deepEqual(x.asked, [], "nothing is asked for a link in the box");
      await x.click("#chat-form .chat-send");
      await x.page.waitForFunction(() => window.__backend.state.requests.some((r) => r.type === "send_pip_message"));
      const sent = (await x.requests("send_pip_message"))[0];
      assert.equal(sent.text, LINK, "the Pip receives the link itself");
      assert.equal("display_mentions" in sent, false);
      await x.page.waitForFunction(() => document.getElementById("pips-host").shadowRoot.querySelector(".pip-message.user .md-link.prompt-link img.link-favicon")?.naturalWidth > 0, null, { timeout: 5000 });
      const link = await x.inPips((root) => { const a = root.querySelector(".pip-message.user .md-link.prompt-link"), img = a.querySelector("img"), b = img.getBoundingClientRect(); return { target: a.dataset.target, src: img.getAttribute("src"), size: [Math.round(b.width), Math.round(b.height)], colour: getComputedStyle(a).color, words: getComputedStyle(a.closest(".bubble")).color }; });
      assert.equal(link.target, LINK);
      assert.equal(link.src, "https://www.google.com/s2/favicons?domain=https%3A%2F%2Fvibedgc.com&sz=32");
      assert.ok(link.size[0] === link.size[1] && link.size[0] >= 12 && link.size[0] <= 16, `the icon is the size of its words: ${link.size}`);
      assert.notEqual(link.colour, link.words, "it reads as a link, in the link's own colour");
      await x.inPips((root) => root.querySelector(".pip-message.user .md-link.prompt-link").click());
      assert.deepEqual((await x.posted("openExternal")).map((m) => m.url), [LINK], "and opens through Work's one route out");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("in the side bar: a favicon that cannot load is caught inside the Pips view's own root, and the bundled mark is drawn", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ icons: "refuse" });
  try {
    await paste(x, LINK);
    await x.click("#chat-form .chat-send");
    await x.page.waitForFunction(() => { const a = document.getElementById("pips-host").shadowRoot.querySelector(".pip-message.user .md-link.prompt-link"); return a && !a.querySelector("img") && a.dataset.linkSource === "dgc"; }, null, { timeout: 5000 });
    const mark = await x.inPips((root) => { const s = getComputedStyle(root.querySelector(".pip-message.user .md-link.prompt-link"), "::before"); return { family: s.fontFamily, content: s.content, width: parseFloat(s.width) }; });
    assert.match(mark.family, /codicon/);
    assert.ok(mark.content !== "none" && mark.width > 0, `the mark is a glyph of the editor's icon font: ${JSON.stringify(mark)}`);
    const before = x.asked.length;
    await x.inPips((root) => { root.querySelector("#chatText").focus(); document.execCommand("insertText", false, "a"); });
    await x.send({ type: "pipsUnreadChanged" }); await x.page.waitForTimeout(500);
    assert.equal(x.asked.length, before, "and it is not asked for again as the page redraws");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("in the side bar: Open in editor is a row of ⋯, and what the chat's other pages say reaches this one", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ width: 300 });
  try {
    assert.equal(await x.inPips((root) => !!root.querySelector("#pip-open-editor")?.checkVisibility()), false, "no icon in a 300 px header");
    await x.click(".pip-topbar .pip-menu > summary");
    // (This Pip has a folder, so its menu starts with Run now: Open in editor is the row after it, then the Pip's pages.)
    assert.deepEqual(await x.inPips((root) => [...root.querySelectorAll(".pip-topbar .pip-menu .tabs-menu > button")].slice(0, 2).map((b) => b.textContent.trim())), ["Run now", "Open in editor"]);
    await x.click(".pip-topbar .pip-menu [data-open-chat-tab]");
    const asked = await x.posted("pipsOpenChat");
    assert.equal(asked.length, 1);
    assert.equal(asked[0].pip.id, GST);
    assert.equal(asked[0].documentId, "doc", "it goes to the host as the side bar's other Pips messages do");
    // Typed here, the host is told (for the chat's other pages).
    await x.inPips((root) => { root.querySelector("#chatText").focus(); document.execCommand("insertText", false, "Check the totals"); });
    await x.page.waitForFunction(() => window.__posted.some((m) => m.type === "pipsChatDraft" && m.text === "Check the totals"), null, { timeout: 3000 });
    // Typed in its editor tab: the host tells Work's page, which passes it on to the Pips view.
    await x.send({ type: "pipsChatDraft", pip_id: GST, conversation_id: "", text: "Check https://vibedgc.com too", parts: ["Check ", { kind: "link", label: "https://vibedgc.com", wire: "https://vibedgc.com", identity: "" }, " too"] });
    await x.page.waitForFunction(() => document.getElementById("pips-host").shadowRoot.querySelector("#chatText").value === "Check https://vibedgc.com too", null, { timeout: 3000 });
    assert.deepEqual((await box(x)).pills, [["link", "https://vibedgc.com", "vibedgc.com"]]);
    // Sent or answered there: this page reads the chat again at once.
    const reads = async () => (await x.requests("list_pip_messages")).length, before = await reads();
    await x.send({ type: "pipsChatChanged", pip_id: GST });
    await x.page.waitForFunction((n) => window.__backend.state.requests.filter((r) => r.type === "list_pip_messages").length > n, before, { timeout: 2000 });
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
