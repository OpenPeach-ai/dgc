// 79.2 (16 Nov): a queued message's restore copy, kept across a window reload, carries its @ marks where they stood and
// its Artifact choice; the host keeps them bounded and gives them back as they were.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeProvider } from "./support/panel-bundle.mjs";

after(() => cleanup());

const saving = (provider) => { const saved = {}; provider.context.workspaceState = { get: (k) => saved[k], update: async (k, v) => { saved[k] = v; } }; return saved; };
const PARTS = ["Also add a note to the changelog ", { kind: "skill", label: "fixture", wire: "", identity: "" }];

test("a queued message is kept with its marks and its Artifact choice, and handed back with them after a reload", () => {
  const a = makeProvider(), saved = saving(a.provider);
  a.provider.trackPrompt("p-1", "Also add a note to the changelog", { text: "Also add a note to the changelog ", attachments: [{ label: "$fixture", skill: "fixture" }], parts: PARTS, output: "slides" }, undefined);
  a.provider.markPromptQueued("p-1");
  const kept = Object.values(saved).find((v) => v && Array.isArray(v.items));
  assert.ok(kept, "kept for the next host");
  assert.deepEqual(kept.items[0].draft.parts, PARTS, "the marks where they stood");
  assert.equal(kept.items[0].draft.output, "slides", "the Artifact choice");
  // The next host (a reload): it reads them back as they were.
  const b = makeProvider(); b.provider.context.workspaceState = a.provider.context.workspaceState;
  b.provider.adoptQueuedPromptsFromPreviousHost();
  assert.deepEqual(b.provider.unsentPrompts.map((p) => [p.requestId, p.draft.parts, p.draft.output]), [["p-1", PARTS, "slides"]]);
});

test("marks that are too many or not marks are left out; the words are kept", () => {
  const a = makeProvider(); saving(a.provider);
  a.provider.trackPrompt("p-2", "hi", { text: "hi", attachments: [], parts: Array(300).fill("x"), output: "x".repeat(41) }, undefined);
  a.provider.trackPrompt("p-3", "hi", { text: "hi", attachments: [], parts: [{ kind: "skill", label: 5 }], output: "doc" }, undefined);
  const p2 = a.provider.unstartedPrompts.get("p-2").draft, p3 = a.provider.unstartedPrompts.get("p-3").draft;
  assert.deepEqual([p2.text, p2.parts, p2.output], ["hi", undefined, undefined]);
  assert.deepEqual([p3.parts, p3.output], [undefined, "doc"]);
});
