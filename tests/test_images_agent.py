"""Image generation in Work (0.51): the tools are offered every turn, a free generator runs without a card, a paid one
shows its Allow card with provider, model, size, count and price in every mode (auto too), Always allow makes that
generator stop asking without writing a permission rule, and the pictures arrive as 0.50's image tiles."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from image_fakes import FakeImages  # noqa: E402
from test_subagents import Harness  # noqa: E402

from dgc import images  # noqa: E402
from dgc.llm import ToolCall  # noqa: E402


class AgentCase(unittest.TestCase):
    def setUp(self):
        self.fake = FakeImages()
        self.addCleanup(self.fake.close)
        self.state = Path(tempfile.mkdtemp(prefix="dgc-images-agent-"))
        env = patch.dict(os.environ, {"DGC_HOME": str(self.state)})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DGC_SESSION_POLICY", None)

    def harness(self, *generators, **data):
        directory = tempfile.TemporaryDirectory(prefix="dgc-images-agent-project-")
        self.addCleanup(directory.cleanup)
        harness = Harness(Path(directory.name), **data)
        self.addCleanup(harness.close)
        rows = {"comfy": {"id": "comfy", "name": "ComfyUI on gpu-box", "provider": "comfyui",
                          "base_url": self.fake.url, "model": "sd_xl_turbo_1.0_fp16.safetensors", "size": "512x512"},
                "fal": {"id": "fal", "name": "fal FLUX schnell", "provider": "fal", "base_url": self.fake.url,
                        "model": "fal-ai/flux/schnell"}}
        if generators:
            harness.config.set_images({"generators": [rows[g] for g in generators]}, persist=False)
            if "fal" in generators:
                harness.config.set_image_key("fal", "fal-key", persist=False)
        return harness

    def names(self, agent):
        return {tool["function"]["name"] for tool in agent._tool_schemas()}

    def frames(self, harness, kind):
        return [f for f in harness.stream.frames() if f["type"] == kind]


class Offered(AgentCase):
    def test_every_turn_set_up_or_not_whatever_the_prompt_says(self):
        harness = self.harness()
        agent = harness.agent
        self.assertTrue({"generate_image", "list_image_generators"} <= self.names(agent))
        agent._activate_tool_intents("fix the typo in README", replace=True)
        self.assertTrue({"generate_image", "list_image_generators"} <= self.names(agent))

    def test_plan_mode_can_read_them_but_not_make_one(self):
        harness = self.harness("comfy", mode="plan")
        names = self.names(harness.agent)
        self.assertIn("list_image_generators", names)
        self.assertNotIn("generate_image", names)

    def test_not_to_a_sub_agent(self):
        harness = self.harness()
        harness.agent.depth = 1
        self.assertFalse({"generate_image", "list_image_generators"} & self.names(harness.agent))


class Running(AgentCase):
    def test_a_free_generator_runs_without_a_card_even_in_default_mode(self):
        harness = self.harness("comfy", mode="default")
        out = harness.agent._handle_call(ToolCall("g1", "generate_image", {"prompt": "a lighthouse at dusk"}))
        self.assertTrue(out.startswith("Made 1 image with ComfyUI on gpu-box"), out)
        self.assertEqual(self.frames(harness, "permission_request"), [])
        shown = self.frames(harness, "tool_images")
        self.assertEqual(len(shown), 1, "0.50's image tiles")
        self.assertEqual(shown[0]["call_id"], "g1")
        # (items, with each image's ref, come with a saved session; this harness has none)
        self.assertEqual(shown[0]["caption"], "generated image")
        self.assertTrue(shown[0]["images"][0].startswith("data:image/png;base64,"))
        # In DGC's own folder, one per session (as Codex keeps its pictures), not in the project.
        from dgc import images
        saved = list((images.directory() / "sessions" / "work").glob("*.png"))
        self.assertEqual(len(saved), 1)
        self.assertTrue(saved[0].with_suffix(".json").exists(), "its sidecar")
        self.assertEqual(list(Path(harness.config.project_root).rglob("*.png")), [], "nothing in the project")
        self.assertIn("That's DGC's own folder, not the project. If the user wants it in the project, call "
                      "generate_image again with save_to", out)

    def test_a_paid_generator_asks_in_auto_mode_with_its_price(self):
        harness = self.harness("fal")
        self.assertEqual(harness.config.get("mode"), "auto")
        harness.answer("permission_request", {"decision": "no"})
        out = harness.agent._handle_call(ToolCall("g1", "generate_image", {"prompt": "a cat", "count": 2,
                                                                          "size": "1024x1024"}))
        self.assertIn("DENIED", out)
        card = self.frames(harness, "permission_request")[-1]
        self.assertEqual(card["name"], "generate_image")
        self.assertEqual({k: card["args"][k] for k in ("generator", "provider", "model", "size", "count", "price")},
                         {"generator": "fal FLUX schnell", "provider": "fal.ai", "model": "fal-ai/flux/schnell",
                          "size": "1024x1024", "count": 2, "price": "about $0.006 (about $0.003 each)"})
        self.assertEqual([r for r in self.fake.requests if r["path"].startswith("/fal-ai/")], [], "nothing spent")

    def test_a_public_openai_compatible_generator_asks_in_auto_mode(self):
        # A hosted OpenAI-compatible service is paid (images.is_paid): newly added, it shows its card, as fal does.
        from unittest.mock import Mock
        from dgc import image_providers as P
        harness = self.harness()
        harness.config.set_images({"generators": [{"id": "hosted", "name": "Hosted images",
                                                   "provider": "openai_compatible",
                                                   "base_url": "https://images.example.com",
                                                   "model": "paid-image-model"}]}, persist=False)
        self.assertTrue(images.settings(harness.config)["generators"][0]["asks"])
        harness.answer("permission_request", {"decision": "no"})
        adapter = Mock()
        with patch.object(P, "adapter_for", return_value=adapter):
            out = harness.agent._handle_call(ToolCall("g1", "generate_image", {"prompt": "a cat"}))
        self.assertIn("DENIED", out)
        card = self.frames(harness, "permission_request")[-1]
        self.assertEqual((card["name"], card["args"]["generator"]), ("generate_image", "Hosted images"))
        adapter.generate.assert_not_called()

    def test_an_unknown_price_under_a_limit_shows_its_card_though_asking_is_off(self):
        harness = self.harness("fal")
        block = images.settings(harness.config)
        block["generators"][0].update(asks=False, monthly_limit_usd=5)
        harness.config.set_images(block, persist=False)
        harness.answer("permission_request", {"decision": "no"})
        out = harness.agent._handle_call(ToolCall("g1", "generate_image", {"prompt": "a cat",
                                                                          "model": "fal-ai/brand-new-model"}))
        self.assertIn("DENIED", out)
        card = self.frames(harness, "permission_request")[-1]
        self.assertEqual(card["args"]["price"], "price unknown")
        self.assertIn("can't keep this within your $5.00 monthly limit", card["args"]["note"])
        self.assertEqual([r for r in self.fake.requests if r["path"].startswith("/fal-ai/")], [])

    def test_a_live_card_is_never_answered_by_the_rules_auto_mode_included(self):
        # A front end that keeps its card open re-checks the rules while it waits (the TUI, the editor): in auto mode
        # the plain rule allows generate_image, and that once answered a paid image's card by itself.
        harness = self.harness("fal")
        seen = []

        def approve_live(ui, name, args, call_id=None, *, recheck=None):
            seen.append(recheck())
            return "no"
        with patch.object(type(harness.ui), "approve_live", approve_live, create=True):
            out = harness.agent._handle_call(ToolCall("g1", "generate_image", {"prompt": "a cat"}))
        self.assertEqual(seen, [None], "the rules never answer it")
        self.assertIn("DENIED", out)
        self.assertEqual([r for r in self.fake.requests if r["path"].startswith("/fal-ai/")], [])

    def test_always_allow_makes_that_generator_stop_asking_without_a_rule(self):
        harness = self.harness("fal")
        harness.answer("permission_request", {"decision": "always"})
        out = harness.agent._handle_call(ToolCall("g1", "generate_image", {"prompt": "a cat"}))
        self.assertTrue(out.startswith("Made 1 image with fal FLUX schnell"), out)
        self.assertFalse(images.settings(harness.config)["generators"][0]["asks"])
        self.assertEqual(harness.config.permissions["allow"], [], "no permission rule was written")
        harness.agent._handle_call(ToolCall("g2", "generate_image", {"prompt": "a dog"}))
        self.assertEqual(len(self.frames(harness, "permission_request")), 1, "the second asked no more")

    def test_several_fit_dgc_asks_which_and_remembers_it(self):
        harness = self.harness("comfy", "fal")
        harness.answer("options_request", {"answers": {"generator": {"selected": [0]}}})
        out = harness.agent._handle_call(ToolCall("g1", "generate_image", {"prompt": "a fox"}))
        self.assertTrue(out.startswith("Made 1 image with ComfyUI on gpu-box"), out)
        question = self.frames(harness, "options_request")[0]["questions"][0]
        self.assertEqual(question["header"], "Image generator")
        self.assertEqual([o["label"] for o in question["options"]], ["ComfyUI on gpu-box", "fal FLUX schnell"])
        self.assertEqual(images.project_choice(harness.config.project_root), "comfy")
        harness.agent._handle_call(ToolCall("g2", "generate_image", {"prompt": "another"}))
        self.assertEqual(len(self.frames(harness, "options_request")), 1, "asked once for the project")

    def test_a_client_that_asked_about_images_hears_images_made(self):
        harness = self.harness("comfy")
        harness.agent._handle_call(ToolCall("g1", "generate_image", {"prompt": "a fox"}))
        self.assertEqual(self.frames(harness, "images_made"), [], "never to a client that didn't ask")
        harness.ui._images_watch = True
        harness.agent._handle_call(ToolCall("g2", "generate_image", {"prompt": "a fox", "count": 2}))
        made = self.frames(harness, "images_made")
        self.assertEqual(len(made), 1)
        self.assertEqual((made[0]["call_id"], made[0]["generator"], len(made[0]["images"])), ("g2", "comfy", 2))
        self.assertEqual(made[0]["cost_usd"], 0.0)

    def test_the_cards_one_line_says_what_it_costs(self):
        from dgc.ui import arg_summary
        self.assertEqual(arg_summary("generate_image", {"generator": "fal FLUX schnell", "count": 2,
                                                         "size": "1024x1024", "price": "about $0.006"}),
                         "fal FLUX schnell · 2 × 1024x1024 · about $0.006")

    def test_needs_credit_with_one_paid_other_asks_the_user_with_a_way_out(self):
        harness = self.harness("fal")
        block = images.settings(harness.config)
        block["generators"].append({"id": "gemini", "name": "Gemini Flash Image", "provider": "gemini",
                                    "base_url": self.fake.url, "model": "gemini-2.5-flash-image", "asks": False})
        harness.config.set_images(block, persist=False)
        harness.config.set_image_key("gemini", "g-key", persist=False)
        self.fake.mode["gemini"] = "no_billing"
        harness.answer("options_request", {"answers": {"generator": {"selected": [1]}}})
        out = harness.agent._handle_call(ToolCall("g1", "generate_image", {"prompt": "a croissant",
                                                                          "generator": "gemini"}))
        question = self.frames(harness, "options_request")[0]["questions"][0]
        self.assertEqual([o["label"] for o in question["options"]], ["fal FLUX schnell", "Don't make it"])
        self.assertIn("needs credit", question["question"])
        self.assertIn("The user chose no other generator, so no image was made.", out)
        self.assertEqual([r for r in self.fake.requests if r["path"].startswith("/fal-ai/")], [])

    def test_list_image_generators_reads_without_a_card(self):
        harness = self.harness("comfy", "fal", mode="default")
        out = harness.agent._handle_call(ToolCall("l1", "list_image_generators", {}))
        self.assertIn("Image generators (2)", out)
        self.assertEqual(self.frames(harness, "permission_request"), [])


class ToolRow(AgentCase):
    """The step's row in the editor and the terminal reads a short line; the model reads every sentence for it."""

    def test_the_row_is_plain_and_the_model_still_reads_the_rest(self):
        harness = self.harness("comfy")
        out = harness.agent._handle_call(ToolCall("g1", "generate_image", {"prompt": "a lighthouse at dusk"}))
        self.assertIn("A sidecar .json", out)
        self.assertIn("The user sees it in the chat.", out)
        [row] = [f for f in self.frames(harness, "tool_result") if f["call_id"] == "g1"]
        lines = row["output"].splitlines()
        self.assertEqual(lines[0], "Made 1 image with ComfyUI on gpu-box · 16×16 · free")
        self.assertRegex(lines[1], r"\.dgc/images/sessions/work/[^/]+\.png$")
        self.assertNotIn("sidecar", row["output"])
        self.assertNotIn("DGC's own folder", row["output"], "said to the model, not in the person's row")
        self.assertNotIn("The user sees", row["output"])
        self.assertFalse(row["is_error"])


if __name__ == "__main__":
    unittest.main()
