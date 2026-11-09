// A Work session's fallback model (D14, 9 Nov; fallback on every surface, part C): the ⋯ beside a model in Work's
// model menu (this session's route, a saved provider, or a model an All models provider lists), Main and Fallback at
// the rows' right end, only from a CLI that offers it; Claude Code or Codex too (part E, on its own default model); and
// the model button in olive while the fallback answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDom } from "./support/webview-dom.mjs";

const SPARE = `provider_${"c".repeat(32)}`;
const FB = (extra = {}) => ({ offered: true, model: "", base_url: "", route_base: "http://127.0.0.1:11434/v1", ...extra });
const ROUTES = [{ key: "native", label: "Ollama" },
  { key: SPARE, label: "Spare", kind: "native", base_url: "https://spare.example/v1", model: "gpt-oss:120b" },
  { key: "codex", label: "Codex", kind: "subscription" }];

test("Work: the ⋯ beside a model sets this session's fallback; Main and Fallback at the right end", () => {
  const { doc, send, posted, errors } = makeDom();
  doc.getElementById("btn-model").click();
  send({ type: "models", ids: ["deepseek-v4.1-flash:cloud", "glm-5.3:cloud"], current: "deepseek-v4.1-flash:cloud",
    routes: ROUTES, currentRouteKey: "native", fallback: FB() });
  const menu = doc.getElementById("modelmenu");
  assert.equal(menu.querySelectorAll(".dgc-menu-pill").length, 0, "no fallback yet: no words");
  const dots = menu.querySelector('[data-fb-more="m:1"]');
  assert.ok(dots, "a model of this session's host has a ⋯");
  assert.equal(dots.getAttribute("aria-label"), "More for glm-5.3:cloud");
  dots.click();
  assert.deepEqual([...menu.querySelectorAll(".dgc-menu-choices button")].map((b) => b.textContent), ["Use as main", "Use as fallback"]);
  menu.querySelector('[data-fb-set="m:1"]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.filter((m) => m.type === "setFallback").at(-1))), { type: "setFallback", provider: "", model: "glm-5.3:cloud" });
  const pill = (sel) => [...menu.querySelectorAll(`${sel} .dgc-menu-pill`)].map((p) => p.textContent);
  assert.deepEqual(pill('[data-i="0"]'), ["Main"]);
  assert.deepEqual(pill('[data-i="1"]'), ["Fallback"]);
  // Providers: a saved provider can be the fallback (its own model), and so can Codex; Current host can't.
  menu.querySelector("[data-provider-back]").click();
  assert.ok(menu.querySelector('[data-fb-more="p:1"]'), "a saved provider has a ⋯");
  assert.equal(menu.querySelector('[data-fb-more="p:0"]'), null, "Current host names no one model");
  assert.ok(menu.querySelector('[data-fb-more="p:2"]'), "Codex can be a fallback");
  menu.querySelector('[data-fb-more="p:1"]').click();
  menu.querySelector('[data-fb-set="p:1"]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.filter((m) => m.type === "setFallback").at(-1))), { type: "setFallback", provider: SPARE, model: "gpt-oss:120b" });
  assert.deepEqual(pill('[data-provider-i="1"]'), ["Fallback"]);
  assert.deepEqual(pill('[data-provider-i="0"]'), ["Main"], "the main model's provider");
  menu.querySelector('[data-fb-more="p:1"]').click();
  assert.match(menu.querySelector('[data-fb-set="p:1"]').textContent, /Stop using as fallback/);
  menu.querySelector('[data-fb-set="p:1"]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.filter((m) => m.type === "setFallback").at(-1))), { type: "setFallback", provider: "", model: "" });
  // Codex as the fallback: named by its CLI, on its own default model.
  menu.querySelector('[data-fb-more="p:2"]').click();
  assert.deepEqual([...menu.querySelectorAll(".dgc-menu-choices button")].map((b) => b.textContent), ["Use as main", "Use as fallback"]);
  menu.querySelector('[data-fb-set="p:2"]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.filter((m) => m.type === "setFallback").at(-1))), { type: "setFallback", provider: "codex", model: "" });
  assert.deepEqual(pill('[data-provider-i="2"]'), ["Fallback"]);
  assert.deepEqual(pill('[data-provider-i="0"]'), ["Main"]);
  assert.deepEqual(pill('[data-provider-i="1"]'), [], "only one fallback");
  assert.deepEqual(errors, []);
});

test("Work: a session's Claude Code or Codex fallback, told after a reload, shows on its row; its own CLI is Main", () => {
  const { doc, send, posted, errors } = makeDom();
  doc.getElementById("btn-model").click();
  const routes = [{ key: "codex", label: "Codex", kind: "subscription", engine: "codex" },
    { key: "subscription_claude", label: "Claude Code", kind: "subscription", engine: "claude" }];
  send({ type: "models", ids: ["gpt-5.6-sol"], current: "gpt-5.6-sol", subscription: true, label: "Codex", routes,
    currentRouteKey: "codex", fallback: FB({ engine: "claude" }) });
  const menu = doc.getElementById("modelmenu");
  assert.equal(menu.querySelector("[data-fb-more]"), null, "a CLI's own models have no ⋯");
  menu.querySelector("[data-provider-back]").click();
  const pill = (sel) => [...menu.querySelectorAll(`${sel} .dgc-menu-pill`)].map((p) => p.textContent);
  assert.deepEqual(pill('[data-provider-i="0"]'), ["Main"]);
  assert.deepEqual(pill('[data-provider-i="1"]'), ["Fallback"]);
  menu.querySelector('[data-fb-more="p:1"]').click();
  assert.match(menu.querySelector('[data-fb-set="p:1"]').textContent, /Stop using as fallback/);
  menu.querySelector('[data-fb-set="p:1"]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.filter((m) => m.type === "setFallback").at(-1))), { type: "setFallback", provider: "", model: "" });
  assert.deepEqual(pill('[data-provider-i="1"]'), []);
  menu.querySelector('[data-fb-more="p:0"]').click();
  assert.ok(menu.querySelector('[data-fb-set="p:0"]').disabled, "its main can't be its fallback too");
  assert.deepEqual(errors, []);
});

test("Work: no ⋯ from an older CLI, none for a CLI's own models; the button in olive while the fallback answers", () => {
  const { doc, send, errors } = makeDom();
  doc.getElementById("btn-model").click();
  send({ type: "models", ids: ["deepseek-v4.1-flash:cloud"], current: "deepseek-v4.1-flash:cloud", routes: ROUTES,
    currentRouteKey: "native", fallback: { offered: false } });
  assert.equal(doc.querySelector("#modelmenu [data-fb-more]"), null, "an older CLI: no ⋯");
  send({ type: "models", ids: ["gpt-5.6-sol"], current: "", subscription: true, label: "Codex", routes: ROUTES,
    currentRouteKey: "codex", fallback: FB() });
  assert.equal(doc.querySelector("#modelmenu [data-fb-more]"), null, "Codex's own models have no ⋯ (Codex is one, on its default)");
  send({ type: "fallbackActive", model: "glm-5.3:cloud" });
  const button = doc.getElementById("btn-model");
  assert.ok(button.classList.contains("on-fallback"));
  assert.equal(doc.getElementById("modelname").textContent, "glm-5.3:cloud");
  assert.equal(button.querySelector(".model-fallback-word").textContent, "fallback");
  assert.match(button.title, /didn’t answer, so its fallback glm-5\.3:cloud is answering/);
  send({ type: "fallbackActive", model: "" });
  assert.ok(!button.classList.contains("on-fallback"));
  assert.equal(button.querySelector(".model-fallback-word"), null);
  assert.deepEqual(errors, []);
});

test("Work: the model button's name, its fallback word and its reasoning share one text baseline", () => {
  // Centred boxes of different sizes put an 11px "Default" on a half pixel, a pixel below a 12px name (seen 9 Nov).
  const css = readFileSync(new URL("../media/main.css", import.meta.url), "utf8");
  const rule = css.match(/\.model-control \.model-copy\s*\{([^}]*)\}/);
  assert.ok(rule, "the button's text row has its rule");
  assert.match(rule[1], /align-items:\s*baseline/);
  const word = css.match(/#btn-model \.model-fallback-word\s*\{([^}]*)\}/);
  assert.match(word[1], /margin:\s*0 2px;/, "the word has the same room on both sides");
  assert.match(css, /#btn-model\.on-fallback \.model-chevron \{ color: var\(--err-text\); opacity: \.7; \}/, "its chevron in the olive too, as a Pip's and ChatDGC's");
});

test("Work: a long model or provider name stays on one line (its … at rest), slides while pointed at, and its whole name is its tooltip (9 Nov)", () => {
  const { doc, send, errors } = makeDom();
  doc.getElementById("btn-model").click();
  send({ type: "models", ids: ["deepseek-v4.1-flash:cloud", "glm-5.3:cloud"], current: "deepseek-v4.1-flash:cloud",
    routes: ROUTES, currentRouteKey: "native", fallback: FB({ model: "glm-5.3:cloud" }) });
  const menu = doc.getElementById("modelmenu");
  const label = menu.querySelector('[data-i="0"] .dgc-menu-label');
  assert.ok(label, "a model row's name is one line, not two beside its Main word");
  assert.equal(label.textContent, "deepseek-v4.1-flash:cloud");
  assert.equal(label.getAttribute("title"), "deepseek-v4.1-flash:cloud");
  assert.ok(menu.__dgcSlide, "the menu slides a long name while its row is pointed at or focused");
  menu.querySelector("[data-provider-back]").click();
  const provider = menu.querySelector('[data-provider-i="1"] .dgc-menu-label');
  assert.ok(provider && provider.getAttribute("title") === "Spare", "a provider row's name too");
  assert.deepEqual(errors, []);
});

test("Work: a long name sliding in the model menu shows no tooltip over the row above; one at rest still does (9 Nov)", () => {
  const { doc, send, advance, errors } = makeDom({ clock: true });
  doc.getElementById("btn-model").click();
  send({ type: "models", ids: ["deepseek-v4.1-flash:cloud", "glm-5.3:cloud"], current: "deepseek-v4.1-flash:cloud",
    routes: ROUTES, currentRouteKey: "native", fallback: FB({ model: "glm-5.3:cloud" }) });
  const tip = () => [...doc.querySelectorAll(".tip")].find((n) => !n.hidden) || null;
  const rest = doc.querySelector('#modelmenu [data-i="1"] .dgc-menu-label');
  rest.dispatchEvent(new doc.defaultView.Event("pointerover", { bubbles: true }));
  advance(1000);
  assert.ok(tip() && /glm-5\.3:cloud/.test(tip().textContent), "at rest: its tooltip");
  rest.dispatchEvent(new doc.defaultView.Event("pointerout", { bubbles: true }));
  doc.body.dispatchEvent(new doc.defaultView.Event("pointerover", { bubbles: true }));
  advance(1000);
  const sliding = doc.querySelector('#modelmenu [data-i="0"] .dgc-menu-label');
  sliding.classList.add("is-sliding");          // what DgcMenu.slide does on its next frame
  sliding.dispatchEvent(new doc.defaultView.Event("pointerover", { bubbles: true }));
  advance(1000);
  assert.equal(tip(), null, "sliding: it shows its whole name itself");
  assert.deepEqual(errors, []);
});
