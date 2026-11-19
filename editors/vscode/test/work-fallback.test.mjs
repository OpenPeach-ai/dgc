// A Work session's fallback model (D14, 9 Nov; fallback on every surface, part C; in the one model picker since 17 Nov):
// the ⋯ beside a model in Work's picker (a model of this session's route or of a saved provider), Main and Fallback at
// the rows' right end, only from a CLI that offers it; Claude Code or Codex too (part E, on its own default model: its
// "CLI default" row); and the model button in red while the fallback answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDom } from "./support/webview-dom.mjs";
import { pickerDom } from "./support/picker-dom.mjs";

const SPARE = `provider_${"c".repeat(32)}`;
const FB = (extra = {}) => ({ offered: true, model: "", base_url: "", route_base: "http://127.0.0.1:11434/v1", ...extra });
const ROUTES = [{ key: "native", label: "Ollama" },
  { key: SPARE, label: "Spare", kind: "native", base_url: "https://spare.example/v1", model: "gpt-oss:120b" },
  { key: "codex", label: "Codex", kind: "subscription" }];

const last = (posted) => JSON.parse(JSON.stringify(posted.filter((m) => m.type === "setFallback").at(-1) ?? null));

test("Work: the ⋯ beside a model sets this session's fallback; Main and Fallback at the right end", () => {
  const { doc, send, posted, errors } = makeDom();
  doc.getElementById("btn-model").click();
  send({ type: "models", ids: ["deepseek-v4.1-flash:cloud", "glm-5.3:cloud"], current: "deepseek-v4.1-flash:cloud",
    routes: ROUTES, currentRouteKey: "native", fallback: FB() });
  const p = pickerDom(doc);
  assert.deepEqual(p.pills(), [], "no fallback yet: no words");
  const dots = p.more("glm-5.3:cloud");
  assert.ok(dots, "a model of this session's host has a ⋯");
  assert.equal(dots.getAttribute("aria-label"), "More for glm-5.3:cloud");
  dots.click();
  assert.deepEqual(p.choices().map((b) => b.textContent), ["Use as main", "Use as fallback"]);
  p.choices()[1].click();
  assert.deepEqual(last(posted), { type: "setFallback", provider: "", model: "glm-5.3:cloud" });
  assert.deepEqual(p.pills(), [["deepseek-v4.1-flash:cloud", "Main"], ["glm-5.3:cloud", "Fallback"]]);
  assert.equal(p.open(), true, "the picker stays, and says it");
  p.more("deepseek-v4.1-flash:cloud").click();
  assert.deepEqual(p.choices().map((b) => [b.textContent, b.disabled]), [["Use as fallback", true]], "its main can't be its fallback too");
  // A saved provider's models can be the fallback, and so can Codex, on its own default model.
  p.conn(SPARE).click();
  send({ type: "providerModels", id: SPARE, ids: ["gpt-oss:120b", "big:1"] });
  p.more("gpt-oss:120b").click();
  p.choices()[1].click();
  assert.deepEqual(last(posted), { type: "setFallback", provider: SPARE, model: "gpt-oss:120b" });
  assert.deepEqual(p.pills(), [["gpt-oss:120b", "Fallback"]]);
  p.conn("native").click();
  assert.deepEqual(p.pills(), [["deepseek-v4.1-flash:cloud", "Main"]], "only one fallback");
  p.conn(SPARE).click();
  p.more("gpt-oss:120b").click();
  assert.match(p.choices()[1].textContent, /Stop using as fallback/);
  p.choices()[1].click();
  assert.deepEqual(last(posted), { type: "setFallback", provider: "", model: "" });
  assert.deepEqual(p.pills(), []);
  // Codex as the fallback: named by its CLI, on its own default model.
  p.conn("codex").click();
  assert.deepEqual(p.names(), ["CLI default"]);
  p.more("CLI default").click();
  assert.deepEqual(p.choices().map((b) => b.textContent), ["Use as main", "Use as fallback"]);
  p.choices()[1].click();
  assert.deepEqual(last(posted), { type: "setFallback", provider: "codex", model: "" });
  assert.deepEqual(p.pills(), [["CLI default", "Fallback"]]);
  p.conn("native").click();
  assert.deepEqual(p.pills(), [["deepseek-v4.1-flash:cloud", "Main"]]);
  // Use as main is choosing it.
  p.more("glm-5.3:cloud").click();
  p.choices()[0].click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.filter((m) => m.type === "setModel").at(-1))), { type: "setModel", model: "glm-5.3:cloud" });
  assert.equal(p.open(), false);
  assert.deepEqual(errors, []);
});

test("Work: a session's Claude Code or Codex fallback, told after a reload, shows on its row; its own CLI is Main", () => {
  const { doc, send, posted, errors } = makeDom();
  doc.getElementById("btn-model").click();
  const routes = [{ key: "codex", label: "Codex", kind: "subscription", engine: "codex", hints: ["gpt-5.6-sol"] },
    { key: "subscription_claude", label: "Claude Code", kind: "subscription", engine: "claude", hints: ["opus"] }];
  send({ type: "models", ids: ["gpt-5.6-sol"], current: "gpt-5.6-sol", subscription: true, label: "Codex", routes,
    currentRouteKey: "codex", fallback: FB({ engine: "claude" }) });
  const p = pickerDom(doc);
  assert.equal(doc.querySelector(".dgc-mp-more"), null, "the session's own CLI can't be its own fallback: its models have no ⋯");
  assert.deepEqual(p.pills(), [["gpt-5.6-sol", "Main"]]);
  p.conn("subscription_claude").click();
  assert.deepEqual(p.pills(), [["CLI default", "Fallback"]]);
  assert.equal(doc.querySelectorAll(".dgc-mp-more").length, 1, "of a CLI's rows, only its own default can be the fallback");
  p.more("CLI default").click();
  assert.match(p.choices()[1].textContent, /Stop using as fallback/);
  p.choices()[1].click();
  assert.deepEqual(last(posted), { type: "setFallback", provider: "", model: "" });
  assert.deepEqual(p.pills(), []);
  assert.deepEqual(errors, []);
});

test("Work: no ⋯ from an older CLI, none for the session's own CLI; the button in red while the fallback answers", () => {
  const { doc, send, errors } = makeDom();
  doc.getElementById("btn-model").click();
  send({ type: "models", ids: ["deepseek-v4.1-flash:cloud"], current: "deepseek-v4.1-flash:cloud", routes: ROUTES,
    currentRouteKey: "native", fallback: { offered: false } });
  const p = pickerDom(doc);
  assert.deepEqual(p.names(), ["deepseek-v4.1-flash:cloud"]);
  assert.equal(doc.querySelector(".dgc-mp-more"), null, "an older CLI: no ⋯");
  p.conn("codex").click();
  assert.equal(doc.querySelector(".dgc-mp-more"), null);
  send({ type: "models", ids: ["gpt-5.6-sol"], current: "", subscription: true, label: "Codex", routes: ROUTES,
    currentRouteKey: "codex", fallback: FB() });
  assert.deepEqual(p.names(), ["CLI default", "gpt-5.6-sol"]);
  assert.equal(doc.querySelector(".dgc-mp-more"), null, "Codex's own models have no ⋯ while the session runs on Codex");
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
  assert.match(css, /#btn-model\.on-fallback \.model-chevron \{ color: var\(--err-text\); opacity: \.7; \}/, "its chevron in the red too, as a Pip's and ChatDGC's");
});

test("Work: a long model name stays on one line (its … at rest), slides while pointed at, and its whole name is its tooltip (9 Nov)", () => {
  const { doc, send, errors } = makeDom();
  doc.getElementById("btn-model").click();
  send({ type: "models", ids: ["deepseek-v4.1-flash:cloud", "glm-5.3:cloud"], current: "deepseek-v4.1-flash:cloud",
    routes: ROUTES, currentRouteKey: "native", fallback: FB({ model: "glm-5.3:cloud" }) });
  const p = pickerDom(doc);
  const label = p.row("deepseek-v4.1-flash:cloud").querySelector(".dgc-menu-label");
  assert.ok(label, "a model row's name is one line, not two beside its Main word");
  assert.equal(label.textContent, "deepseek-v4.1-flash:cloud");
  assert.equal(label.getAttribute("title"), "deepseek-v4.1-flash:cloud");
  assert.ok(p.box().__dgcSlide, "the picker slides a long name while its row is pointed at or focused");
  assert.equal(p.conn(SPARE).title, "Spare · your key", "a connection's name is its mark's label");
  assert.deepEqual(errors, []);
});

test("Work: a long name sliding in the model picker shows no tooltip over the row above; one at rest still does (9 Nov)", () => {
  const { doc, send, advance, errors } = makeDom({ clock: true });
  doc.getElementById("btn-model").click();
  send({ type: "models", ids: ["deepseek-v4.1-flash:cloud", "glm-5.3:cloud"], current: "deepseek-v4.1-flash:cloud",
    routes: ROUTES, currentRouteKey: "native", fallback: FB({ model: "glm-5.3:cloud" }) });
  const p = pickerDom(doc);
  const tip = () => [...doc.querySelectorAll(".tip")].find((n) => !n.hidden) || null;
  const rest = p.row("glm-5.3:cloud").querySelector(".dgc-menu-label");
  rest.dispatchEvent(new doc.defaultView.Event("pointerover", { bubbles: true }));
  advance(1000);
  assert.ok(tip() && /glm-5\.3:cloud/.test(tip().textContent), "at rest: its tooltip");
  rest.dispatchEvent(new doc.defaultView.Event("pointerout", { bubbles: true }));
  doc.body.dispatchEvent(new doc.defaultView.Event("pointerover", { bubbles: true }));
  advance(1000);
  const sliding = p.row("deepseek-v4.1-flash:cloud").querySelector(".dgc-menu-label");
  sliding.classList.add("is-sliding");          // what DgcMenu.slide does on its next frame
  sliding.dispatchEvent(new doc.defaultView.Event("pointerover", { bubbles: true }));
  advance(1000);
  assert.equal(tip(), null, "sliding: it shows its whole name itself");
  assert.deepEqual(errors, []);
});
