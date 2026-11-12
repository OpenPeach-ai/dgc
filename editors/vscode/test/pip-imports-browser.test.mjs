// pips-18, the editor half, in real Chromium with the real Pips bundle (test/support/pip-chat-scene.mjs, opts.teams at
// Pips API 88): the Teams menu's two more rows, Import from GitHub… (one link, DGC's refusal kept in the dialog, then
// the cards under a line that names what came) and Bring a Grok bot… (DGC's prompt to copy, a box for the reply, then
// its one card under DGC's notes). Nothing is cut off, pokes out or lies on something else, dark and light, in a tab
// (700 px) and in the side bar (300 px); and in a short side bar a dialog's buttons stay in view while it scrolls.
// DGC_IMPORTS_PICTURES=<folder> keeps a picture of each.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromiumOrNull, isPurple } from "./support/look-probe.mjs";
import { openChat } from "./support/pip-chat-scene.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const PICTURES = process.env.DGC_IMPORTS_PICTURES || "";
if (PICTURES) mkdirSync(PICTURES, { recursive: true });
const picture = async (p, name) => { if (!PICTURES) return; await p.waitForTimeout(250); await p.screenshot({ path: `${PICTURES}/${name}.png` }); };
const sent = (p, type) => p.evaluate((t) => (window.__sent || []).filter((r) => r.type === t).map(({ type: _t, ...rest }) => rest), type);
const open = (theme, width, opts = {}) => openChat(browser, { width, height: 1000, theme, where: width > 400 ? "tab" : "side", api: 88, settings: true, apps: true, convs: true, many: true, teams: true, home: true, ...opts });
const menuRow = async (p, id) => { await p.locator(".team-menu > summary").click(); await p.waitForSelector(`.team-menu[open] #${id}`); await p.locator(`#${id}`).click(); await p.waitForSelector("[role=dialog]"); };
const gone = (p) => p.waitForFunction(() => !(window.__pipsRoot || document).querySelector("[role=dialog]"));
const alertSays = async (p, words) => { await p.waitForFunction((w) => ((window.__pipsRoot || document).querySelector("[role=dialog] [role=alert]")?.textContent || "").includes(w), words); return p.locator("[role=dialog] [role=alert]").innerText(); };

const GOOD = "https://github.com/acme/pips/blob/main/launch-crew.dgc-team.json";
const REPLY = 'Here is my description:\n```json\n{"dgc_import": 1, "name": "Deal Finder", "job": "Find the best deals on flights to Goa each week and tell me.",\n "kind": "scout", "skills": ["compare prices", "watch fares"],\n "routines": [{"when": "every Monday at 9:00", "what": "Check fares to Goa"}]}\n```';

/** What the eye would catch inside `selector` (pass to page.evaluate): a control outside the box or past its edge, words
    cut sideways by their box, two controls on each other, the page scrolling sideways, and each button's fill. */
const looked = (selector) => {
  const root = window.__pipsRoot || document, sec = root.querySelector(selector), box = (n) => n.getBoundingClientRect(), seen = (n) => n.checkVisibility() && box(n).width > 1;
  const card = box(sec);
  const controls = [...sec.querySelectorAll("button, input, textarea")].filter(seen);
  const poking = controls.filter((c) => box(c).right > card.right + 0.5 || box(c).left < card.left - 0.5 || box(c).bottom > card.bottom + 0.5 || box(c).top < card.top - 0.5).map((c) => (c.textContent.trim() || c.id || c.className).slice(0, 40));
  const cut = [...sec.querySelectorAll("button, strong, small, h2, p, label, .import-step-says")].filter(seen).filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).display !== "inline").map((n) => n.textContent.trim().slice(0, 30));
  const over = []; for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) { const a = box(controls[i]), b = box(controls[j]);
    if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) over.push(`${(controls[i].textContent.trim() || controls[i].id).slice(0, 24)} / ${(controls[j].textContent.trim() || controls[j].id).slice(0, 24)}`); }
  const fills = [...sec.querySelectorAll("button")].filter(seen).map((b) => ({ text: (b.textContent.trim() || b.getAttribute("aria-label") || "").slice(0, 30), fill: getComputedStyle(b).backgroundColor }));
  const purple = [...sec.querySelectorAll("*")].filter(seen).filter((n) => [getComputedStyle(n).backgroundColor, getComputedStyle(n).borderTopColor].some((c) => c)).map((n) => [n, getComputedStyle(n)])
    .filter(([, s]) => s.backgroundColor !== "rgba(0, 0, 0, 0)" || parseFloat(s.borderTopWidth) > 0).map(([n, s]) => ({ tag: (n.id || n.className || n.tagName).toString().slice(0, 30), fill: s.backgroundColor, edge: parseFloat(s.borderTopWidth) > 0 ? s.borderTopColor : "" }));
  return { poking, cut, over, fills, purple, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
};
function checkLayout(m, solid, { filled = [], page = false } = {}) {
  assert.deepEqual(m.poking, [], "no control pokes out of its box");
  assert.deepEqual(m.cut, [], "no words are cut by their box");
  assert.deepEqual(m.over, [], "no two controls lie on each other");
  assert.deepEqual(m.fills.filter((b) => isPurple(b.fill)).map((b) => b.text), [], "no purple button");
  if (!page) assert.deepEqual(m.purple.filter((n) => isPurple(n.fill) || (n.edge && isPurple(n.edge))).map((n) => n.tag), [], "nothing in it is filled or edged purple");
  assert.deepEqual(m.fills.filter((b) => b.fill === solid && !filled.includes(b.text)).map((b) => b.text), [], "no filled button but the one that goes ahead");
  assert.equal(m.sideways, false, "nothing scrolls sideways");
}
/** The dialog and its two buttons (pass to page.evaluate): in view, the buttons inside it, clickable, on one line. */
const dialogRead = () => {
  const root = window.__pipsRoot || document, d = root.querySelector("[role=dialog]"), box = (n) => n.getBoundingClientRect(), c = box(d), vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const hit = (n) => { const b = box(n), top = root.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!top && (top === n || n.contains(top)); };
  const go = root.querySelector("#review-confirm"), cancel = root.querySelector("#review-cancel"), bar = d.querySelector(".actions");
  const within = (n) => { const b = box(n); return b.top >= c.top - 0.5 && b.bottom <= c.bottom + 0.5 && b.left >= c.left - 0.5 && b.right <= c.right + 0.5 && b.bottom <= vh + 0.5; };
  return { title: d.querySelector("h2").textContent, says: d.querySelector("h2 + p").textContent, inView: c.left >= -0.5 && c.right <= vw + 0.5 && c.top >= -0.5 && c.bottom <= vh + 0.5,
    confirm: [go.textContent, go.disabled], cancel: cancel.textContent, buttonsIn: within(go) && within(cancel), buttonsHit: (go.disabled || hit(go)) && hit(cancel),
    oneLine: Math.abs(box(go).top - box(cancel).top) < 1 && box(cancel).right <= box(go).left + 0.5,
    scrolls: d.scrollHeight > d.clientHeight + 1, scrollTop: Math.round(d.scrollTop), barFill: getComputedStyle(bar).backgroundColor, fill: getComputedStyle(d).backgroundColor,
    focus: (root.activeElement || document.activeElement)?.id || "" };
};
const checkDialog = (m) => {
  assert.ok(m.inView, "the dialog is wholly in view: " + JSON.stringify(m));
  assert.ok(m.buttonsIn && m.buttonsHit && m.oneLine, "Cancel and the button that goes ahead are in view, side by side, and can be clicked: " + JSON.stringify(m));
};

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  const solid = theme === "dark" ? "rgb(0, 120, 212)" : "rgb(0, 95, 184)";

  test(`the Teams menu has four rows: the two team rows, then Import from GitHub… and Bring a Grok bot… (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(theme, width);
    try {
      await x.p.locator(".team-menu > summary").click(); await x.p.waitForSelector(".team-menu[open] #team-import-grok");
      const menu = await x.p.evaluate(() => { const root = window.__pipsRoot || document, m = root.querySelector(".team-menu .tabs-menu"), r = m.getBoundingClientRect();
        const hit = (n) => { const b = n.getBoundingClientRect(), top = root.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!top && (top === n || n.contains(top)); };
        return { rows: [...m.querySelectorAll("button")].map((b) => [b.textContent, hit(b), b.scrollWidth <= b.clientWidth + 1, b.disabled]), heights: [...m.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().height)),
          inView: r.left >= 0 && r.right <= document.documentElement.clientWidth + 0.5 && r.bottom <= document.documentElement.clientHeight + 0.5, shared: m.classList.contains("dgc-menu"), fill: getComputedStyle(m).backgroundColor }; });
      assert.deepEqual(menu.rows, [["Export team…", true, true, false], ["Import team…", true, true, false], ["Import from GitHub…", true, true, false], ["Bring a Grok bot…", true, true, false]]);
      assert.equal(new Set(menu.heights).size, 1, "every row is the same height");
      assert.ok(menu.inView && menu.shared, "the shared menu, wholly in view"); assert.equal(isPurple(menu.fill), false);
      await picture(x.p, `menu-${theme}-${width}`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
    // An older DGC has no folders and no Teams menu, so neither row.
    const old = await open(theme, width, { api: 87 });
    try { assert.equal(await old.p.evaluate(() => !!(window.__pipsRoot || document).querySelector("#team-import-github, #team-import-grok")), false); } finally { await old.close(); }
  });

  test(`Import from GitHub…: one link and which addresses work; DGC's refusal stays in the dialog; then the cards under a line naming what came (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(theme, width);
    try {
      await menuRow(x.p, "team-import-github"); await x.p.waitForSelector("[role=dialog] #importLink");
      let m = await x.p.evaluate(dialogRead);
      assert.deepEqual([m.title, m.confirm, m.cancel, m.focus], ["Import from GitHub", ["Import", false], "Cancel", "importLink"]); checkDialog(m);
      const field = await x.p.evaluate(() => { const root = window.__pipsRoot || document, d = root.querySelector("[role=dialog]"), f = root.querySelector("#importLink"), s = root.querySelector("#import-link-says");
        return { wide: f.getBoundingClientRect().width > d.getBoundingClientRect().width * 0.7, label: f.closest("label").firstChild.textContent, says: s.textContent, saysUnder: s.getBoundingClientRect().top >= f.getBoundingClientRect().bottom, described: f.getAttribute("aria-describedby") }; });
      assert.ok(field.wide && field.saysUnder, "the link's box is the dialog's width, its line under it"); assert.equal(field.label, "Link to the file"); assert.equal(field.described, "import-link-says");
      for (const host of ["github.com", "raw.githubusercontent.com", "gist.githubusercontent.com"]) assert.ok(field.says.includes(host), `the line names ${host}`);
      checkLayout(await x.p.evaluate(looked, "[role=dialog]"), solid, { filled: ["Import"] });
      await picture(x.p, `github-empty-${theme}-${width}`);
      // Nothing typed, or an address that isn't GitHub's: said in the dialog, and DGC is not asked.
      await x.p.locator("#review-confirm").click();
      assert.equal(await alertSays(x.p, "Paste"), "Paste a GitHub link to a team file or a Pip file.");
      await x.p.locator("#importLink").fill("https://example.com/team.json"); await x.p.keyboard.press("Enter");
      assert.match(await alertSays(x.p, "https link"), /^Paste an https link to a file on GitHub/);
      assert.deepEqual(await sent(x.p, "import_pip_source"), []);
      // A file DGC can't read: its own words, in the dialog, and the link is still there to fix.
      await x.p.locator("#importLink").fill("https://github.com/acme/pips/blob/main/missing.dgc-team.json"); await x.p.locator("#review-confirm").click();
      assert.equal(await alertSays(x.p, "couldn't read"), "DGC couldn't read that file from GitHub (HTTPError).");
      m = await x.p.evaluate(dialogRead); checkDialog(m); assert.deepEqual(m.confirm, ["Import", false]);
      assert.equal(await x.p.locator("#importLink").inputValue(), "https://github.com/acme/pips/blob/main/missing.dgc-team.json");
      const alert = await x.p.evaluate(() => { const root = window.__pipsRoot || document, d = root.querySelector("[role=dialog]").getBoundingClientRect(), a = root.querySelector("[role=dialog] [role=alert]"), r = a.getBoundingClientRect(), bar = root.querySelector("[role=dialog] .actions").getBoundingClientRect();
        return { inside: r.left >= d.left && r.right <= d.right + 0.5, whole: a.scrollWidth <= a.clientWidth + 1, aboveButtons: r.bottom <= bar.top + 0.5 }; });
      assert.ok(alert.inside && alert.whole && alert.aboveButtons, "the refusal is whole, inside the dialog, above its buttons");
      checkLayout(await x.p.evaluate(looked, "[role=dialog]"), solid, { filled: ["Import"] });
      await picture(x.p, `github-error-${theme}-${width}`);
      // A good link: the dialog closes and the cards wait where new Pips do.
      await x.p.locator("#importLink").fill(`  ${GOOD}  `); await x.p.keyboard.press("Enter");
      await gone(x.p);
      await x.p.waitForFunction(() => /Researcher|Writer|Fact check/.test((window.__pipsRoot || document).querySelector('[aria-label="Needs attention"]')?.textContent || ""));
      assert.deepEqual((await sent(x.p, "import_pip_source")).at(-1), { source: "github", url: GOOD }, "the source and the link, and nothing else");
      const n = await x.p.evaluate(() => { const root = window.__pipsRoot || document, n = root.querySelector(".notice"), a = root.querySelector('[aria-label="Needs attention"]'), box = (el) => el.getBoundingClientRect();
        return { notice: n.textContent, whole: n.scrollWidth <= n.clientWidth + 1 && box(n).right <= document.documentElement.clientWidth + 0.5, above: box(n).bottom <= box(a).top + 0.5, cards: a.textContent, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }; });
      assert.equal(n.notice, "Imported “Launch crew” from GitHub: 3 new Pips to review. Nothing is created until you approve each one. Not included: Reads from connected apps: they name your accounts.");
      assert.ok(n.whole && n.above, "the line is whole, above the cards"); assert.equal(n.sideways, false);
      assert.match(n.cards, /Create the Pip “(Researcher|Writer|Fact check)”\?/); assert.match(n.cards, /of 3/, "its three cards, one shown at a time");
      assert.deepEqual(await sent(x.p, "accept_pip_setup"), [], "nothing is approved by importing");
      checkLayout(await x.p.evaluate(looked, '[aria-label="Needs attention"]'), solid, { filled: ["Review"], page: true });
      await picture(x.p, `imported-github-${theme}-${width}`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`Bring a Grok bot…: DGC's prompt to copy, a box for the reply, DGC's refusal in the dialog, then its one card under DGC's notes (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(theme, width);
    try {
      await menuRow(x.p, "team-import-grok"); await x.p.waitForSelector("[role=dialog] #importPrompt");
      let m = await x.p.evaluate(dialogRead);
      assert.deepEqual([m.title, m.confirm, m.cancel], ["Bring a Grok bot", ["Import", false], "Cancel"]); checkDialog(m);
      const read = () => x.p.evaluate(() => { const root = window.__pipsRoot || document, d = root.querySelector("[role=dialog]"), box = (n) => n.getBoundingClientRect(), c = box(d);
        const prompt = root.querySelector("#importPrompt"), reply = root.querySelector("#importReply"), copy = root.querySelector("#import-prompt-copy"), steps = [...d.querySelectorAll(".import-step-says")];
        return { prompt: prompt.value, readOnly: prompt.readOnly, promptWide: box(prompt).width > c.width * 0.7, replyWide: box(reply).width > c.width * 0.7, order: box(prompt).bottom <= box(copy).top + 0.5 && box(copy).bottom <= box(reply).top + 0.5,
          steps: steps.map((s) => s.textContent), numbers: steps.map((s) => { const n = s.querySelector(".import-step-n"); return [Math.round(box(n).width), Math.round(box(n).height), box(n).right <= box(s).right]; }),
          copy: copy.textContent, copied: root.querySelector("#import-copied").textContent, reply: reply.value, replyHolder: reply.placeholder, focus: (root.activeElement || document.activeElement)?.id || "" }; });
      let g = await read();
      assert.match(g.prompt, /^I'm moving you to another app called DGC\./); assert.match(g.prompt, /"dgc_import": 1/); assert.ok(g.readOnly, "the prompt is read-only");
      assert.deepEqual(g.steps, ["1Paste this prompt into your Grok bot, then paste its reply below.", "2Its reply"]);
      assert.deepEqual(g.numbers, [[18, 18, true], [18, 18, true]], "each step's number is a small round mark");
      assert.ok(g.promptWide && g.replyWide && g.order, "the prompt, Copy under it, then the reply's box, each the dialog's width");
      assert.deepEqual([g.copy, g.copied, g.reply, g.focus], ["Copy", "", "", "import-prompt-copy"], "the keyboard starts on Copy");
      assert.deepEqual(await sent(x.p, "get_pip_import_prompt"), [{}]);
      checkLayout(await x.p.evaluate(looked, "[role=dialog]"), solid, { filled: ["Import"] });
      await picture(x.p, `grok-prompt-${theme}-${width}`);
      // Copy: the host is handed the prompt, and the button says so without the dialog being drawn again.
      await x.p.locator("#import-prompt-copy").click();
      g = await read(); assert.deepEqual([g.copy, g.copied, g.focus], ["Copied", "Now paste it into your Grok bot.", "import-prompt-copy"]);
      assert.deepEqual(await x.p.evaluate(() => (window.__posted || []).filter((v) => v.type === "copy").map((v) => v.text)), [g.prompt], "the whole prompt, once");
      checkLayout(await x.p.evaluate(looked, "[role=dialog]"), solid, { filled: ["Import"] });
      // Nothing pasted, then a reply with no JSON block: said in the dialog, the second in DGC's words.
      await x.p.locator("#review-confirm").click();
      assert.equal(await alertSays(x.p, "Paste"), "Paste what your Grok bot wrote."); assert.deepEqual(await sent(x.p, "import_pip_source"), []);
      await x.p.locator("#importReply").fill("Sure! I am a helpful bot."); await x.p.locator("#review-confirm").click();
      assert.equal(await alertSays(x.p, "no JSON block"), "There is no JSON block in what you pasted. Ask your Grok bot again with the prompt DGC gave you.");
      g = await read(); assert.deepEqual([g.reply, g.copy], ["Sure! I am a helpful bot.", "Copied"], "what was pasted is still there to fix");
      m = await x.p.evaluate(dialogRead); checkDialog(m);
      // A reply pasted: what was said about the last try goes, and the box keeps the keyboard.
      await x.p.locator("#importReply").fill(REPLY);
      assert.equal(await x.p.evaluate(() => !!(window.__pipsRoot || document).querySelector("[role=dialog] [role=alert]")), false, "typing clears the last refusal");
      assert.equal((await read()).focus, "importReply");
      await x.p.evaluate(() => { (window.__pipsRoot || document).querySelector("[role=dialog]").scrollTo(0, 0); });
      checkLayout(await x.p.evaluate(looked, "[role=dialog]"), solid, { filled: ["Import"] });
      await picture(x.p, `grok-reply-${theme}-${width}`);
      await x.p.locator("#review-confirm").click(); await gone(x.p);
      await x.p.waitForFunction(() => /Deal Finder/.test((window.__pipsRoot || document).querySelector('[aria-label="Needs attention"]')?.textContent || ""));
      assert.deepEqual((await sent(x.p, "import_pip_source")).at(-1), { source: "grok", text: REPLY }, "the source and what was pasted, and nothing else");
      const n = await x.p.evaluate(() => { const root = window.__pipsRoot || document, n = root.querySelector(".notice"), a = root.querySelector('[aria-label="Needs attention"]'), box = (el) => el.getBoundingClientRect();
        return { notice: n.textContent, whole: n.scrollWidth <= n.clientWidth + 1 && box(n).right <= document.documentElement.clientWidth + 0.5, above: box(n).bottom <= box(a).top + 0.5, cards: a.textContent, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }; });
      assert.equal(n.notice, "Imported “Deal Finder” from your Grok bot: one new Pip to review. Nothing is created until you approve it. Its skills in Grok: compare prices, watch fares. Add the ones you want on its page. "
        + "A routine it had: every Monday at 9:00: Check fares to Goa. Add it on its page. Imported from a Grok bot: it arrives with no keys and no app access.");
      assert.ok(n.whole && n.above, "the line is whole, above the card"); assert.equal(n.sideways, false);
      assert.match(n.cards, /Create the Pip “Deal Finder”\?/); assert.deepEqual(await sent(x.p, "accept_pip_setup"), []);
      checkLayout(await x.p.evaluate(looked, '[aria-label="Needs attention"]'), solid, { filled: ["Review"], page: true });
      await picture(x.p, `imported-grok-${theme}-${width}`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`in a short window a dialog's buttons stay in view while it scrolls: the Grok dialog and Export team (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(theme, width, { height: 440 });
    try {
      const scrollTo = (y) => x.p.evaluate((top) => { const d = (window.__pipsRoot || document).querySelector("[role=dialog]"); d.scrollTo(0, top === "end" ? d.scrollHeight : top); }, y);
      await menuRow(x.p, "team-import-grok"); await x.p.waitForSelector("[role=dialog] #importPrompt");
      await scrollTo(0);
      let m = await x.p.evaluate(dialogRead);
      assert.ok(m.scrolls, "the dialog is taller than this window, so it scrolls"); assert.equal(m.scrollTop, 0);
      checkDialog(m); assert.equal(m.barFill, m.fill, "the buttons' bar is the dialog's own ground, so nothing shows through it");
      await picture(x.p, `grok-short-${theme}-${width}`);
      // The reply's box is under the bar until you scroll; scrolled to the end, everything is clear of the buttons.
      await scrollTo("end"); m = await x.p.evaluate(dialogRead); checkDialog(m); assert.ok(m.scrollTop > 0);
      const clear = await x.p.evaluate(() => { const root = window.__pipsRoot || document, bar = root.querySelector("[role=dialog] .actions").getBoundingClientRect(), last = root.querySelector("[role=dialog] .import-says").getBoundingClientRect(), reply = root.querySelector("#importReply").getBoundingClientRect();
        return last.bottom <= bar.top + 0.5 && reply.bottom <= bar.top + 0.5; });
      assert.ok(clear, "at the end the reply's box and the last line are above the buttons");
      // A refusal is brought into view above the buttons.
      await x.p.locator("#review-confirm").click();
      await x.p.waitForFunction(() => !!(window.__pipsRoot || document).querySelector("[role=dialog] [role=alert]"));
      const said = await x.p.evaluate(() => { const root = window.__pipsRoot || document, d = root.querySelector("[role=dialog]").getBoundingClientRect(), a = root.querySelector("[role=dialog] [role=alert]").getBoundingClientRect(), bar = root.querySelector("[role=dialog] .actions").getBoundingClientRect();
        return a.top >= d.top - 0.5 && a.bottom <= bar.top + 0.5; });
      assert.ok(said, "what went wrong is in view, above the buttons"); checkDialog(await x.p.evaluate(dialogRead));
      await x.p.locator("#review-cancel").click(); await gone(x.p);
      // Export team is the same dialog: its buttons scrolled out of a short side bar before.
      await x.p.locator(".team-menu > summary").click(); await x.p.locator("#team-export").click(); await x.p.waitForSelector("[role=dialog] #teamName");
      await scrollTo(0); m = await x.p.evaluate(dialogRead);
      assert.ok(m.scrolls, "Export team is taller than this window too"); checkDialog(m); assert.deepEqual(m.confirm, ["Export…", false]); assert.equal(m.barFill, m.fill);
      await picture(x.p, `export-short-${theme}-${width}`);
      await scrollTo("end"); checkDialog(await x.p.evaluate(dialogRead));
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
