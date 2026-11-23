import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// The model picker's data helpers (media/shared/modelpicker.js), which the pages and the extension's host share: which
// mark a connection wears, how Claude Code's rows are named, Ollama's two sections, and what a model's name earns.
const P = createRequire(import.meta.url)("../media/shared/modelpicker.js");

test("a subscription app and its company's API wear the same mark, told apart by the badge", () => {
  assert.deepEqual(P.markOf({ engine: "claude" }), { mark: "claudecode", badge: "cli" });
  assert.deepEqual(P.markOf({ base_url: "https://api.anthropic.com/v1", name: "Anthropic" }), { mark: "anthropic", badge: "key" });
  assert.deepEqual(P.markOf({ engine: "codex" }), { mark: "openai", badge: "cli" });
  assert.deepEqual(P.markOf({ base_url: "https://api.openai.com/v1" }), { mark: "openai", badge: "key" });
  for (const [engine, mark] of [["qwen", "qwen"], ["kimi", "kimi"], ["copilot", "copilot"]]) assert.deepEqual(P.markOf({ engine }), { mark, badge: "cli" });
  assert.equal(P.tipOf("Claude Code (Pro / Max subscription)", "cli"), "Claude Code · your subscription");
  assert.equal(P.tipOf("Anthropic API", "key"), "Anthropic API · your key");
  assert.equal(P.tipOf("Ollama", ""), "Ollama");
});

test("Ollama on this computer has no badge; an ollama.com key is its own connection with a cloud badge", () => {
  assert.deepEqual(P.markOf({ base_url: "http://localhost:11434/v1" }), { mark: "ollama", badge: "" });
  assert.deepEqual(P.markOf({ base_url: "http://127.0.0.1:11434" }), { mark: "ollama", badge: "" });
  assert.deepEqual(P.markOf({ base_url: "https://ollama.com/v1", name: "Ollama Cloud" }), { mark: "ollama", badge: "cloud" });
});

test("local servers and gateways wear their own mark; anything else is a lettered tile", () => {
  for (const [base_url, mark, badge] of [["http://localhost:8080/v1", "llamacpp", ""], ["http://localhost:1234/v1", "lmstudio", ""], ["http://localhost:8000/v1", "vllm", ""],
    ["https://openrouter.ai/api/v1", "openrouter", "key"], ["https://api.groq.com/openai/v1", "groq", "key"], ["https://api.deepseek.com/v1", "deepseek", "key"],
    ["https://api.together.xyz/v1", "together", "key"], ["https://api.mistral.ai/v1", "mistral", "key"]]) assert.deepEqual(P.markOf({ base_url }), { mark, badge }, base_url);
  assert.deepEqual(P.markOf({ base_url: "http://10.0.0.40:9000/v1", name: "NAS workstation" }), { mark: "", badge: "" });
  assert.deepEqual(P.markOf({ base_url: "https://llm.example.com/v1", name: "Work gateway" }), { mark: "", badge: "key" });
  assert.deepEqual(P.markOf({ base_url: "http://10.0.0.40:9000/v1", name: "NAS Ollama" }), { mark: "ollama", badge: "" }, "a saved name says what it is");
  // A look-alike host is not the company's.
  assert.equal(P.markOf({ base_url: "https://api.anthropic.com.evil.example/v1" }).mark, "");
  assert.match(P.markHtml("", "NAS workstation"), /dgc-mp-tile[^>]*>N</);
  assert.match(P.markHtml("anthropic", "Claude Code"), /<svg/);
  assert.doesNotMatch(P.markHtml("", "<img onerror=x>"), /<img/);
  for (const mark of Object.keys(P.PROVIDER_MARKS)) assert.ok(P.MARK_NAMES[mark], `${mark} has a name`);
});

test("a tile's hue is never one of the purples", () => {
  for (const name of ["a", "b", "c", "NAS", "Work gateway", "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9", "y1", "y2", "y3"]) {
    const hue = Number(/--mp-hue:(\d+)/.exec(P.markHtml("", name))[1]);
    assert.ok(hue < 240 || hue > 300, `${name}: ${hue}`);
  }
});

test("Claude Code's full names are said as a family and a version", () => {
  assert.equal(P.versionLabel("claude-opus-5-5"), "Opus 5.5");
  assert.equal(P.versionLabel("claude-fable-5-2"), "Fable 5.2");
  assert.equal(P.versionLabel("claude-sonnet-5-5-20261001"), "Sonnet 5.5");
  assert.equal(P.versionLabel("claude-haiku-6"), "Haiku 6");
  assert.equal(P.versionLabel("claude-opus-5-5[1m]"), "Opus 5.5 [1m]");
  assert.equal(P.versionLabel("some-other-model"), "some-other-model");
});

test("Claude Code's rows: each nickname with the version it last ran as, then the fixed versions", () => {
  const { followed, fixed } = P.claudeRows({ hints: ["fable", "opus", "sonnet", "haiku"], versions: { opus: "claude-opus-5-5" },
    fixed: ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], current: "opus", value: (name) => `subscription:claude:${name}` });
  assert.deepEqual(followed.map((row) => row.name), ["Fable (newest)", "Opus 5.5", "Sonnet (newest)", "Haiku (newest)"]);
  assert.deepEqual(followed.map((row) => row.value), ["subscription:claude:fable", "subscription:claude:opus", "subscription:claude:sonnet", "subscription:claude:haiku"]);
  assert.match(followed[1].desc, /Follows the newest Opus · now claude-opus-5-5/);
  assert.match(followed[0].desc, /Follows the newest Fable/);
  assert.deepEqual(followed.map((row) => row.current), [false, true, false, false]);
  assert.deepEqual(fixed.map((row) => row.name), ["Fable 5.2", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
  assert.equal(fixed[1].desc, "claude-opus-5-5 · stays on this version");
  assert.equal(fixed[1].value, "subscription:claude:claude-opus-5-5");
  assert.equal(fixed.some((row) => row.current), false, "the nickname is chosen, not the version it runs as today");
  // A session on a full name nobody listed still shows as a fixed row, chosen.
  const held = P.claudeRows({ hints: ["opus"], fixed: ["claude-opus-5-5"], held: "claude-opus-4-9", current: "claude-opus-4-9" });
  assert.deepEqual(held.fixed.map((row) => [row.name, row.current]), [["Opus 5.5", false], ["Opus 4.9", true]]);
});

test("Ollama's list is two sections when it has cloud models, and cloud rows are marked", () => {
  const rows = ["qwen3:8b", "glm-5.3:cloud", "gemma3:27b", "qwen3.8:480b-cloud"].map((id) => ({ id, value: id, name: id }));
  const sections = P.ollamaSections(rows);
  assert.deepEqual(sections.map((s) => [s.title, s.rows.map((r) => r.id)]), [["On this computer", ["qwen3:8b", "gemma3:27b"]], ["Cloud", ["glm-5.3:cloud", "qwen3.8:480b-cloud"]]]);
  assert.ok(sections[1].rows.every((row) => row.cloud === true));
  assert.deepEqual(P.ollamaSections(rows.slice(0, 1)).map((s) => s.title), [""], "one kind: no headings");
});

test("a model's name earns only the marks its family is known for", () => {
  assert.deepEqual(P.facts("claude-opus-5-5"), ["thinks", "images"]);
  assert.deepEqual(P.facts("qwen3-coder:30b"), ["thinks"]);
  assert.deepEqual(P.facts("llava:13b"), ["images"]);
  assert.deepEqual(P.facts("anthropic/claude-sonnet-5-5"), ["thinks", "images"]);
  assert.deepEqual(P.facts("my-own-finetune"), []);
  assert.deepEqual(P.facts(""), []);
});

test("each connection wears its company's own website icon, carried in the picker: nothing to fetch, nothing to clash", () => {
  // Decided 17 Nov: the exact logo for each, then the icons their websites use. A picture is a data: image; a drawing
  // (the three black ones, in the text's colour) has no id (two pickers' marks would clash) and no link.
  for (const mark of ["anthropic", "claudecode", "openai", "ollama", "qwen", "kimi", "moonshot", "copilot", "openrouter", "groq", "deepseek", "together", "mistral", "lmstudio", "vllm", "gemini", "xai", "llamacpp"]) {
    const html = P.markHtml(mark, mark);
    assert.match(html, new RegExp(`data-mark="${mark}"`), mark);
    assert.doesNotMatch(html, /\sid=|href=|xlink|<image|url\(/, `${mark} has no ids or links`);
    for (const src of html.match(/src="[^"]*"/g) || []) assert.match(src, /^src="data:image\/(png|svg\+xml);base64,/, `${mark}: carried in the picker`);
  }
  for (const mark of ["anthropic", "openai", "copilot"]) assert.match(P.markHtml(mark, mark), /currentColor/, `${mark}: in the text's colour`);
  assert.equal(P.markOf({ base_url: "https://api.moonshot.ai/v1", name: "Moonshot" }).mark, "moonshot");
  assert.equal(P.markOf({ engine: "kimi" }).mark, "kimi");
});
