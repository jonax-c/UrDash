from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).parents[1] / "custom_components" / "urdash" / "lovelace_install.py"
SPEC = importlib.util.spec_from_file_location("urdash_lovelace_install", MODULE_PATH)
assert SPEC and SPEC.loader
install = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(install)


class LovelaceInstallTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "title": "Home",
            "views": [
                {"title": "Living", "path": "living", "cards": [{"type": "entities"}]},
                {"title": "Hidden", "path": "hidden", "visible": False, "cards": []},
                {"title": "Detail", "path": "detail", "subview": True, "cards": []},
                {"title": "Kitchen", "cards": []},
                {"title": "Private", "path": "private", "visible": [{"user": "owner"}], "cards": []},
            ],
        }

    def test_only_visible_top_level_views_are_targets(self):
        self.assertEqual(
            ["path:living", "index:3"],
            [view["id"] for view in install.visible_views(self.config, "guest")],
        )

    def test_user_visibility_conditions_are_respected(self):
        guest = [view["id"] for view in install.visible_views(self.config, "guest")]
        owner = [view["id"] for view in install.visible_views(self.config, "owner")]
        self.assertNotIn("path:private", guest)
        self.assertIn("path:private", owner)

    def test_append_is_immutable_and_additive(self):
        card = {"type": "custom:urdash-card", "preview": True, "card": {}}
        updated = install.append_card(self.config, "path:living", card)
        self.assertEqual(1, len(self.config["views"][0]["cards"]))
        self.assertEqual(2, len(updated["views"][0]["cards"]))
        self.assertNotIn("preview", updated["views"][0]["cards"][-1])
        self.assertEqual(self.config["views"][1:], updated["views"][1:])

    def test_index_target_supports_views_without_path(self):
        updated = install.append_card(self.config, "index:3", {"type": "custom:urdash-card"})
        self.assertEqual("custom:urdash-card", updated["views"][3]["cards"][0]["type"])

    def test_hidden_or_missing_target_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "not a visible tab"):
            install.append_card(self.config, "path:hidden", {})
        with self.assertRaisesRegex(ValueError, "no longer exists"):
            install.append_card(self.config, "path:missing", {})

    def test_revision_changes_when_dashboard_changes(self):
        original = install.config_revision(self.config)
        updated = install.append_card(self.config, "path:living", {"type": "custom:urdash-card"})
        self.assertNotEqual(original, install.config_revision(updated))


if __name__ == "__main__":
    unittest.main()
