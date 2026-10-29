"""Malformed shared Pip files and saved authenticator records fail closed."""
import unittest

from dgc import pip_share, pip_totp
from dgc.workspace_registry import RegistryError


class PipImportValidationTests(unittest.TestCase):
    def document(self, **changes):
        pip = {"name": "Example", "goal": "Check source", "pip_type": "scout",
               "scope": "project", "schedule": None}
        pip.update(changes)
        return {"format": "dgc-pip", "version": 1, "pip": pip}

    def test_unhashable_pip_type_is_a_validation_error(self):
        with self.assertRaises(RegistryError):
            pip_share.check(self.document(pip_type=[]))

    def test_invalid_utf8_text_is_a_validation_error(self):
        with self.assertRaises(RegistryError):
            pip_share.parse("\ud800")

    def test_unexpected_verification_plan_is_a_validation_error(self):
        document = self.document(pip_type="pulse", verification_plan=[])
        with self.assertRaises(RegistryError):
            pip_share.setup_request(document, project_root="/tmp", request_key="example")

    def test_unhashable_saved_algorithm_is_invalid(self):
        key = {"secret": "A" * 16, "algorithm": [], "digits": 6, "period": 30}
        self.assertFalse(pip_totp.valid_key(key))


if __name__ == "__main__":
    unittest.main()
