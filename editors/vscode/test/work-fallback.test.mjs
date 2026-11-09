// A Work session's fallback model (D14, 9 Nov; fallback on every surface, part C): the ⋯ beside a model in Work's
// model menu (this session's route, a saved provider, or a model an All models provider lists), Main and Fallback at
// the rows' right end, only from a CLI that offers it; and the model button in olive while the fallback answers.
import { test } from "node:test";
import assert from "node:assert/strict";
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
  // Providers: a saved provider can be the fallback (its own model); Claude Code, Codex and Current host can't.
  menu.querySelector("[data-provider-back]").click();
  assert.ok(menu.querySelector('[data-fb-more="p:1"]'), "a saved provider has a ⋯");
  assert.equal(menu.querySelector('[data-fb-more="p:0"]'), null, "Current host names no one model");
  assert.equal(menu.querySelector('[data-fb-more="p:2"]'), null, "Codex can't be a fallback");
  menu.querySelector('[data-fb-more="p:1"]').click();
  menu.querySelector('[data-fb-set="p:1"]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.filter((m) => m.type === "setFallback").at(-1))), { type: "setFallback", provider: SPARE, model: "gpt-oss:120b" });
  assert.deepEqual(pill('[data-provider-i="1"]'), ["Fallback"]);
  assert.deepEqual(pill('[data-provider-i="0"]'), ["Main"], "the main model's provider");
  menu.querySelector('[data-fb-more="p:1"]').click();
  assert.match(menu.querySelector('[data-fb-set="p:1"]').textContent, /Stop using as fallback/);
  menu.querySelector('[data-fb-set="p:1"]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.filter((m) => m.type === "setFallback").at(-1))), { type: "setFallback", provider: "", model: "" });
  assert.deepEqual(errors, []);
});

test("Work: no ⋯ from an older CLI, none for a subscription's models; the button in olive while the fallback answers", () => {
  const { doc, send, errors } = makeDom();
  doc.getElementById("btn-model").click();
  send({ type: "models", ids: ["deepseek-v4.1-flash:cloud"], current: "deepseek-v4.1-flash:cloud", routes: ROUTES,
    currentRouteKey: "native", fallback: { offered: false } });
  assert.equal(doc.querySelector("#modelmenu [data-fb-more]"), null, "an older CLI: no ⋯");
  send({ type: "models", ids: ["gpt-5.6-sol"], current: "", subscription: true, label: "Codex", routes: ROUTES,
    currentRouteKey: "codex", fallback: FB() });
  assert.equal(doc.querySelector("#modelmenu [data-fb-more]"), null, "Codex's models can't be a fallback");
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
