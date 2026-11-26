"""The .env leak guard hides values that read as secrets, never a model's name (live 15 Nov: a project's .env held
OLLAMA_TEST_MODEL=<a default model>, a 25-character name with letters and digits; DGC then showed the default model
as "[REDACTED]" everywhere it scrubs what it shows)."""
import tempfile
import unittest
from pathlib import Path

from dgc import leak_guard

MODEL_NAMES = ["deepseek-v4.1-flash:cloud", "llama3.1:70b-instruct-q4_K_M", "qwen2.5-coder:32b-instruct-q8_0",
               "hf.co/bartowski/Qwen2.5-Coder-32B-Instruct-GGUF:Q4_K_M", "gpt-oss:120b-cloud-preview",
               "anthropic/claude-opus-5-5", "mistral-small3.2:24b-instruct"]
SECRETS = ["AKIAIOSFODNN7EXAMPLE", "a8Fj3kL0q9ZxP2mN7vB4yT6wR1sD5hG", "123e4567-e89b-12d3-a456-426614174000",
           "Xk9f-2LmQ-8pZr-Tq4w-7Nb3", "3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a",
           "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
           "sk-proj-abc123def456ghi789", "ghp_16C7e42F292c6912E7710c838347Ae178B4a"]


class ModelNamesAreNotSecrets(unittest.TestCase):
    def test_a_model_name_never_reads_as_a_secret(self):
        for name in MODEL_NAMES:
            with self.subTest(name=name):
                self.assertFalse(leak_guard.looks_secret(name), name)

    def test_keys_tokens_hex_and_uuids_still_do(self):
        for value in SECRETS:
            with self.subTest(value=value[:12]):
                self.assertTrue(leak_guard.looks_secret(value), value[:12])

    def test_the_env_file_keeps_its_model_out_and_its_key_in(self):
        root = Path(tempfile.mkdtemp(prefix="dgc-envmodel-"))
        (root / ".env").write_text("OLLAMA_TEST_MODEL=deepseek-v4.1-flash:cloud\nSERVICE_TOKEN=a8Fj3kL0q9ZxP2mN7vB4yT6wR1sD5hG\n"
                                   "DEFAULT_MODEL=llama3.1:70b-instruct-q4_K_M\n", encoding="utf-8")
        values = leak_guard.project_env_values(root)
        self.assertNotIn("deepseek-v4.1-flash:cloud", values)
        self.assertNotIn("llama3.1:70b-instruct-q4_K_M", values)
        self.assertIn("a8Fj3kL0q9ZxP2mN7vB4yT6wR1sD5hG", values)


if __name__ == "__main__":
    unittest.main()
