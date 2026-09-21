// Model-viewed images in the panel (jsdom): chips inside the step that produced them, the viewer
// dialog and its modality, orphan rows, group sentences, attention while the viewer is open, and
// images fetched by ref (history and oversized images).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG2 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8DwnwEJMI4KAgBVZQMf4FhA9QAAAABJRU5ErkJggg==";
const ref = (n) => "img_" + String(n).repeat(32).slice(0, 32);
const item = (n, extra = {}) => ({ ref: ref(n), name: `shot-${n}.png`, mime: "image/png", width: 1280, height: 757,
                                   bytes: 310 * 1024, source: "browser", host: "vibedgc.com", ...extra });

function panel(options = {}) {
  const dom = makeDom(options);
  const event = (ev) => dom.send({ type: "event", event: ev });
  const win = dom.dom.window;
  event({ type: "ready", capabilities: { image_views: true, ...(options.capabilities || {}) } });
  event({ type: "turn_start", turn_id: "t1", prompt: "look at the page" });
  const step = (id, name = "browser", output = "screenshot saved") => {
    event({ type: "tool_call", call_id: id, name, args: {}, summary: name });
    event({ type: "tool_result", call_id: id, name, output, is_error: false, is_diff: false });
  };
  const key = (target, k, extra = {}) => target.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
  const card = (id) => dom.doc.querySelector(`.tool[data-call-id="${id}"]`);
  const open = (id) => card(id).querySelector(".tool-toggle").click();
  const viewer = () => dom.doc.getElementById("image-viewer");
  const flush = () => new Promise((done) => win.setTimeout(done, 0));
  return { ...dom, event, step, key, card, open, viewer, win, flush };
}


// The hover delay is a product constant, so poll for the label rather than sleeping past it.
async function untilShown(win, node, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (node.hidden) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the hover label");
    await new Promise((done) => win.setTimeout(done, 10));
  }
}

test("chips sit inside the card that produced them, collapsed shows only a count", () => {
  const p = panel();
  p.step("c1");
  p.event({ type: "tool_images", call_id: "c1", images: [PNG], caption: "browser screenshot" });
  const card = p.card("c1");
  assert.equal(p.doc.querySelector(".shots"), null);
  assert.equal(p.doc.querySelectorAll("#log img").length, 0, "no img before the toggle");
  const pill = card.querySelector(".tool-toggle > .tool-image-count");
  assert.equal(pill.previousElementSibling.className, "arg", "the pill follows the argument");
  assert.equal(pill.querySelector(".n").textContent, "1");
  assert.equal(pill.querySelector(".sr-only").textContent, "1 image");
  assert.equal(pill.getAttribute("title"), null, "no nested title");
  assert.equal(card.querySelector(".tool-toggle").title, "browser · 1 image");
  assert.ok(card.classList.contains("has-output"), "the clamped text preview stays");
  assert.equal(p.doc.getElementById("announcer").textContent, "Viewed 1 image");

  p.open("c1");
  const row = card.querySelector(".body").firstElementChild;
  assert.ok(row.matches("ul.tool-images[role=list]"), "the chip row is the body's first child");
  assert.equal(row.getAttribute("aria-label"), "Images from this step");
  assert.equal(row.querySelectorAll("li > button.image-chip img").length, 1);
  p.open("c1");
  assert.ok(!card.classList.contains("open"));
  assert.ok(card.querySelector(".tool-images"), "the row stays in the DOM, hidden by CSS when collapsed");
  assert.deepEqual(p.errors, []);
});

test("one click opens a modal viewer; Escape closes it, returns focus, and never stops the turn", () => {
  const p = panel();
  p.step("c1");
  p.event({ type: "tool_images", call_id: "c1", images: [PNG], items: [item(1)] });
  p.open("c1");
  const chip = p.card("c1").querySelector(".image-chip");
  chip.focus();
  chip.click();
  const viewer = p.viewer();
  assert.equal(viewer.getAttribute("role"), "dialog");
  assert.equal(viewer.getAttribute("aria-modal"), "true");
  assert.equal(p.doc.getElementById(viewer.getAttribute("aria-labelledby")).textContent, "shot-1.png");
  assert.equal(p.doc.activeElement.getAttribute("aria-label"), "Close image preview");
  assert.equal(p.doc.getElementById("iv-meta").textContent, "1280×757 · 310 KB · vibedgc.com");

  const exempt = new Set([viewer, p.doc.getElementById("announcer")]);
  const children = [...p.doc.body.children].filter((node) => !exempt.has(node) && !node.classList.contains("tip"));
  assert.ok(children.length >= 8);
  for (const node of children) assert.ok(node.hasAttribute("inert"), `${node.id || node.tagName} is inert`);
  assert.ok(!p.doc.getElementById("announcer").hasAttribute("inert"));

  const buttons = [...viewer.querySelectorAll("button")].filter((b) => !b.disabled && !b.closest("[hidden]"));
  buttons.at(-1).focus();
  p.key(p.doc.activeElement, "Tab");
  assert.equal(p.doc.activeElement, buttons[0], "Tab from the last control wraps inside the viewer");
  p.key(p.doc.activeElement, "Tab", { shiftKey: true });
  assert.equal(p.doc.activeElement, buttons.at(-1));

  p.event({ type: "turn_activity", state: "tool", label: "Working" });
  const before = p.posted.length;
  p.key(p.doc.activeElement, "Escape");
  assert.equal(p.viewer(), null);
  assert.equal(p.doc.activeElement, chip, "focus returns to the chip");
  assert.ok(!p.posted.slice(before).some((m) => m.type === "cancel" || m.type === "stop"), "Escape stops nothing");
  for (const node of children) assert.ok(!node.hasAttribute("inert"), "inert restored exactly");
  assert.ok(p.doc.getElementById("to-latest").hasAttribute("hidden"), "other attributes untouched");
  assert.deepEqual(p.errors, []);
});

test("the sequence spans the group, including a collapsed card; nav stops at the ends", () => {
  const p = panel();
  p.step("c1");
  p.step("c2");
  p.event({ type: "tool_images", call_id: "c1", images: [PNG], items: [item(1)] });
  p.event({ type: "tool_images", call_id: "c2", images: [PNG2], items: [item(2, { name: "second.png" })] });
  assert.equal(p.doc.querySelector(".tool-group-label").textContent, "Looked at 2 pages · 2 images");
  p.open("c1");
  p.card("c1").querySelector(".image-chip").click();
  const viewer = p.viewer();
  assert.equal(viewer.querySelector(".iv-pos").textContent, "1 of 2");
  assert.ok(viewer.querySelector(".iv-prev").disabled);
  p.key(p.doc.activeElement, "ArrowRight");
  assert.equal(viewer.querySelector(".iv-pos").textContent, "2 of 2");
  assert.ok(viewer.querySelector(".iv-next").disabled, "no wrap");
  assert.equal(p.doc.getElementById("announcer").textContent, "Image 2 of 2: second.png");
  assert.equal(viewer.querySelector(".iv-stage img").getAttribute("src"), PNG2);
  assert.ok(!p.card("c2").classList.contains("open"), "the collapsed card was not opened");
  p.key(p.doc.activeElement, "Home");
  assert.equal(viewer.querySelector(".iv-pos").textContent, "1 of 2");
  p.key(p.doc.activeElement, "End");
  p.key(p.doc.activeElement, "z");
  assert.ok(viewer.classList.contains("actual"));
  assert.equal(viewer.querySelector(".iv-zoom").getAttribute("aria-label"), "Fit to panel");
  assert.equal(viewer.querySelector(".iv-zoom").getAttribute("aria-pressed"), "true");
  viewer.querySelector(".iv-stage img").click();
  assert.ok(!viewer.classList.contains("actual"), "clicking the image toggles fit");
  assert.ok(p.viewer(), "and does not close");
  viewer.querySelector(".iv-stage").click();
  assert.equal(p.viewer(), null, "the backdrop closes");
  assert.equal(p.doc.activeElement, p.card("c1").querySelector(".image-chip"),
               "the shown image's card is collapsed, so focus goes back to the opening chip");
  assert.deepEqual(p.errors, []);
});

test("empty images are one Too large chip; orphans get their own row and end the tool group", () => {
  const p = panel();
  p.step("c1");
  p.event({ type: "tool_images", call_id: "c1", images: [], caption: "browser screenshot" });
  p.open("c1");
  const chips = p.card("c1").querySelectorAll(".image-chip");
  assert.equal(chips.length, 1);
  assert.equal(chips[0].querySelector(".image-caption").textContent, "Too large");
  assert.equal(chips[0].title, "This screenshot was too large to send to the panel. It is saved in .dgc/screenshots.");

  p.event({ type: "tool_images", call_id: null, images: [PNG] });
  let orphan = p.doc.querySelector(".image-orphan");
  assert.equal(orphan.querySelector(".verb").textContent, "Viewed an image");
  p.event({ type: "tool_images", call_id: "nobody", images: [PNG, PNG2] });
  assert.equal(p.doc.querySelectorAll(".image-orphan").length, 1, "consecutive orphans share a row");
  assert.equal(orphan.querySelector(".verb").textContent, "Viewed 3 images");
  p.step("c9", "bash", "ok");
  const groups = [...p.doc.querySelectorAll(".tool-group")];
  assert.equal(groups.length, 2, "a later tool opens a new group below the orphan row");
  assert.ok(orphan.compareDocumentPosition(groups[1]) & p.win.Node.DOCUMENT_POSITION_FOLLOWING);
  orphan.querySelector(".tool-toggle").click();
  assert.equal(orphan.querySelectorAll(".image-chip").length, 3);
  orphan.querySelectorAll(".image-chip")[1].click();
  assert.equal(p.viewer().querySelector(".iv-pos").textContent, "2 of 3");
  assert.deepEqual(p.errors, []);
});

test("viewing steps are counted as images, and a diff card with images keeps its body", () => {
  const p = panel();
  p.event({ type: "tool_call", call_id: "v1", name: "view_image", args: { path: "a.png" }, summary: "a.png" });
  assert.equal(p.doc.querySelector(".tool-group-label").textContent, "Viewing an image");
  p.event({ type: "tool_result", call_id: "v1", name: "view_image", output: "viewed a.png", is_error: false, is_diff: false });
  p.event({ type: "tool_images", call_id: "v1", images: [PNG, PNG2] });
  assert.equal(p.doc.querySelector(".tool-group-label").textContent, "Viewed 2 images");
  assert.equal(p.card("v1").querySelector(".verb").textContent, "Viewed image");
  p.event({ type: "tool_call", call_id: "m1", name: "mcp__srv__render", args: {}, summary: "" });
  p.event({ type: "tool_result", call_id: "m1", name: "mcp__srv__render", output: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b",
            is_error: false, is_diff: true, diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b" });
  assert.ok(p.card("m1").classList.contains("no-body"));
  p.event({ type: "tool_images", call_id: "m1", images: [PNG] });
  assert.ok(!p.card("m1").classList.contains("no-body"), "the chips stay reachable");
  assert.equal(p.doc.querySelector(".tool-group-label").textContent, "Viewed 3 images and used 1 tool",
               "the step's image joins the viewed count instead of a second count");
  assert.deepEqual(p.errors, []);
});

test("a request while the viewer is open shows a notice, announces once, and Show focuses the card", async () => {
  const p = panel();
  p.step("c1");
  p.event({ type: "tool_images", call_id: "c1", images: [PNG] });
  p.open("c1");
  p.card("c1").querySelector(".image-chip").click();
  p.event({ type: "permission_request", id: "p1", name: "bash", command: "rm -rf build", args: {}, summary: "rm -rf build",
            suggested_rule: "Bash", choices: ["once", "always", "deny"] });
  await p.flush();
  const notice = p.viewer().querySelector(".iv-notice");
  assert.ok(!notice.hidden);
  assert.match(notice.textContent, /DGC is waiting for your answer\.\s*Show/);
  assert.equal(p.doc.getElementById("announcer").textContent, "Permission required to run bash", "only the request's own line");
  notice.querySelector("button").click();
  assert.equal(p.viewer(), null);
  const card = p.doc.querySelector('.card[data-request-id="p1"]');
  assert.ok(card.contains(p.doc.activeElement), "focus moves into the newest request card");
  assert.ok(![...p.doc.body.children].some((node) => node.hasAttribute("inert")));

  p.card("c1").querySelector(".image-chip").click();
  p.dom.window.dispatchEvent(new p.win.MessageEvent("message", { data: { type: "continue_offer" } }));
  await p.flush();
  assert.ok(!p.viewer().querySelector(".iv-notice").hidden, "a recovery offer is attention too");
  p.viewer().querySelector(".iv-close").click();

  p.card("c1").querySelector(".image-chip").click();
  p.dom.window.dispatchEvent(new p.win.MessageEvent("message", { data: { type: "backend_exit", recovering: false } }));
  await p.flush();
  assert.equal(p.viewer().querySelector(".iv-notice-text").textContent, "DGC's backend stopped.");
  assert.deepEqual(p.errors, []);
});

test("a session change closes the viewer; a history re-render keeps the image but not the sequence", async () => {
  const p = panel();
  p.step("c1");
  p.step("c2");
  p.event({ type: "tool_images", call_id: "c1", images: [PNG] });
  p.event({ type: "tool_images", call_id: "c2", images: [PNG2] });
  p.open("c1");
  p.card("c1").querySelector(".image-chip").click();
  p.event({ type: "session", kind: "cleared", message_count: 0, session_id: "s2" });
  assert.equal(p.viewer(), null);
  assert.ok(![...p.doc.body.children].some((node) => node.hasAttribute("inert")));

  p.event({ type: "turn_start", turn_id: "t2", prompt: "again" });
  p.step("d1");
  p.step("d2");
  p.event({ type: "tool_images", call_id: "d1", images: [PNG] });
  p.event({ type: "tool_images", call_id: "d2", images: [PNG2] });
  p.open("d1");
  p.card("d1").querySelector(".image-chip").click();
  p.event({ type: "history", items: [] });
  p.doc.querySelector(".msg.dgc").remove();       // what a snapshot re-render does to the live blocks
  await p.flush();
  assert.ok(p.viewer(), "still open");
  assert.equal(p.viewer().querySelector(".iv-stage img").getAttribute("src"), PNG);
  assert.ok(p.viewer().querySelector(".iv-prev").disabled && p.viewer().querySelector(".iv-next").disabled);
  p.key(p.doc.activeElement, "Escape");
  assert.equal(p.doc.activeElement, p.doc.getElementById("input"), "focus falls back to the composer");
  assert.deepEqual(p.errors, []);
});

// ---- Phase B: images fetched by ref ----------------------------------------------------------------
test("replayed slots are fetched only for opened cards, two at a time, and fill their chips", () => {
  const p = panel({ clock: true });
  for (const id of ["h1", "h2", "h3"]) p.step(id);
  p.event({ type: "tool_images", call_id: "h1", images: ["", "", ""], items: [item(1), item(2), item(3)] });
  p.event({ type: "tool_images", call_id: "h2", images: [""], items: [item(4)] });
  assert.equal(p.posted.filter((m) => m.type === "getImage").length, 0, "nothing for collapsed cards");
  p.open("h1");
  const asks = p.posted.filter((m) => m.type === "getImage");
  assert.equal(asks.length, 2, "two in flight");
  assert.deepEqual(asks.map((m) => m.ref), [ref(1), ref(2)]);
  const chips = () => [...p.card("h1").querySelectorAll(".image-chip")];
  assert.deepEqual(chips().map((c) => c.dataset.state), ["loading", "loading", "pending"]);
  p.event({ type: "image", request_id: asks[0].requestId, ref: ref(1), image: PNG, mime: "image/png", width: 1280, height: 757 });
  assert.equal(chips()[0].dataset.state, "ready");
  assert.equal(chips()[0].querySelector("img").getAttribute("src"), PNG);
  const third = p.posted.filter((m) => m.type === "getImage")[2];
  assert.equal(third.ref, ref(3), "the queue moves on");

  p.event({ type: "image", request_id: asks[1].requestId, ref: ref(2), image: "", reason: "busy" });
  assert.equal(chips()[1].dataset.state, "pending");
  p.advance(499);
  assert.equal(p.posted.filter((m) => m.type === "getImage").length, 3);
  p.advance(1);
  const retry = p.posted.filter((m) => m.type === "getImage")[3];
  assert.equal(retry.ref, ref(2), "busy retries after 0.5 s");

  p.event({ type: "image", request_id: third.requestId, ref: ref(3), image: "", reason: "too_large", path: "/secret/x.png" });
  const large = chips()[2];
  assert.equal(large.querySelector(".image-caption").textContent, "Too large");
  large.click();
  assert.equal(p.viewer().querySelector(".iv-message").textContent, "Too large to show in the panel. Open the file instead.");
  p.viewer().querySelector('[aria-label="Open file"]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(p.posted.at(-1))), { type: "openImage", ref: ref(3) }, "a ref, never a path");
  p.viewer().querySelector(".iv-close").click();

  p.advance(30000);
  assert.equal(chips()[1].dataset.state, "failed", "a request that never answers times out");
  assert.equal(chips()[1].title, "The panel could not load this image.");
  assert.deepEqual(p.errors, []);
});

test("answers from before a session change are ignored; a backend restart asks again", () => {
  const p = panel();
  p.step("h1");
  p.event({ type: "tool_images", call_id: "h1", images: [""], items: [item(5)] });
  p.open("h1");
  const first = p.posted.filter((m) => m.type === "getImage")[0];
  p.dom.window.dispatchEvent(new p.win.MessageEvent("message", { data: { type: "backend_exit", recovering: true } }));
  assert.equal(p.card("h1").querySelector(".image-chip").dataset.state, "pending");
  p.event({ type: "image", request_id: first.requestId, ref: ref(5), image: PNG });
  assert.equal(p.card("h1").querySelector(".image-chip").dataset.state, "pending", "the stopped backend's answer is ignored");
  p.event({ type: "ready", capabilities: { image_views: true } });
  const again = p.posted.filter((m) => m.type === "getImage");
  assert.equal(again.length, 2);
  assert.notEqual(again[1].requestId, first.requestId);

  p.event({ type: "session", kind: "new", message_count: 0, session_id: "s9" });
  p.event({ type: "image", request_id: again[1].requestId, ref: ref(5), image: PNG });
  assert.deepEqual(p.errors, [], "an answer after a new session does nothing");
});

test("without the capability, slots fail instead of asking; invalid items are ignored", () => {
  const p = panel({ capabilities: { image_views: false } });
  p.event({ type: "ready", capabilities: {} });
  p.event({ type: "turn_start", turn_id: "t2", prompt: "x" });
  p.step("h1");
  p.event({ type: "tool_images", call_id: "h1", images: ["", ""],
            items: [item(6), { ...item(7), bytes: -1 }] });
  p.open("h1");
  const chips = p.card("h1").querySelectorAll(".image-chip");
  assert.equal(chips.length, 1, "the invalid item took its slot with it");
  assert.equal(chips[0].dataset.state, "failed");
  assert.equal(p.posted.filter((m) => m.type === "getImage").length, 0);
  p.event({ type: "tool_images", call_id: "h1", images: ["", ""], items: [item(8)] });
  assert.equal(p.card("h1")._images.length, 1, "a length mismatch is not trusted");
  assert.deepEqual(p.errors, []);
});

test("omitted images are counted after the chips", () => {
  const p = panel();
  p.step("c1", "mcp__srv__charts");
  p.event({ type: "tool_images", call_id: "c1", images: [PNG], omitted: 3 });
  p.open("c1");
  const more = p.card("c1").querySelector(".image-omitted");
  assert.equal(more.textContent, "+3 not shown");
  assert.equal(more.title, "DGC keeps up to 8 images per step, and only PNG, JPEG, GIF, WebP or BMP.");
  assert.deepEqual(p.errors, []);
});

test("a step whose images were all refused says how many were not shown, never 0", () => {
  const p = panel();
  p.step("c1", "mcp__imgsrv__chart");
  p.event({ type: "tool_images", call_id: "c1", images: [], omitted: 2 });
  const pill = p.card("c1").querySelector(".tool-image-count");
  assert.equal(pill.querySelector(".n").textContent, "+2");
  assert.equal(pill.querySelector(".sr-only").textContent, "2 images not shown");
  assert.equal(p.card("c1").querySelector(".tool-toggle").title, "mcp__imgsrv__chart · 2 images not shown");
  p.event({ type: "tool_images", call_id: "c1", images: [PNG] });
  assert.equal(pill.querySelector(".n").textContent, "1", "a shown image is counted as usual");
  assert.deepEqual(p.errors, []);
});

test("a screenshot beside a viewing step is counted once, in the viewed phrase", () => {
  const p = panel();
  p.step("c1");
  p.event({ type: "tool_images", call_id: "c1", images: [PNG] });
  p.event({ type: "tool_call", call_id: "v1", name: "view_image", args: { path: "a.png" }, summary: "a.png" });
  p.event({ type: "tool_result", call_id: "v1", name: "view_image", output: "viewed a.png", is_error: false, is_diff: false });
  p.event({ type: "tool_images", call_id: "v1", images: [PNG2] });
  assert.equal(p.doc.querySelector(".tool-group-label").textContent, "Looked at 1 page and viewed 2 images");
  assert.deepEqual(p.errors, []);
});

test("no hover label covers the viewer: not on the focus it places, not over the attention notice", async () => {
  const p = panel();
  p.step("c1");
  p.event({ type: "tool_images", call_id: "c1", images: [PNG] });
  p.open("c1");
  p.card("c1").querySelector(".image-chip").click();
  await p.flush();
  const tip = p.doc.getElementById("hover-tip");
  assert.equal(p.doc.activeElement, p.viewer().querySelector(".iv-close"));
  assert.ok(tip.hidden, "the programmatic focus on Close raises no label");
  // A label a keyboard user raised on a bar control is taken down when the notice appears.
  p.viewer().querySelector(".iv-zoom").dispatchEvent(new p.win.Event("pointerover", { bubbles: true }));
  await untilShown(p.win, tip);
  assert.ok(!tip.hidden, "a hover label shows as usual");
  p.event({ type: "permission_request", id: "p1", name: "bash", command: "ls", args: {}, summary: "ls",
            suggested_rule: "Bash", choices: ["once", "always", "deny"] });
  await p.flush();
  assert.ok(!p.viewer().querySelector(".iv-notice").hidden);
  assert.ok(tip.hidden, "the notice's Show button is not covered");
  assert.deepEqual(p.errors, []);
});

test("an image read_file viewed sits in the read step and reads as a workspace image", () => {
  const p = panel();
  p.step("r1", "read_file", "viewed logo.png (image/png, 64×48, 1 KB). The image follows this batch, so you can look at it directly.");
  p.event({ type: "tool_images", call_id: "r1", images: [PNG], caption: "viewed image",
            items: [item(4, { name: "logo.png", width: 64, height: 48, bytes: 1024, source: "read_file", host: "" })] });
  const card = p.card("r1");
  assert.equal(card.querySelector(".tool-image-count .n").textContent, "1");
  p.open("r1");
  card.querySelector(".image-chip").click();
  assert.equal(p.doc.getElementById("iv-title").textContent, "logo.png");
  assert.equal(p.doc.getElementById("iv-meta").textContent, "64×48 · 1 KB · Workspace image");
  assert.deepEqual(p.errors, []);
});
