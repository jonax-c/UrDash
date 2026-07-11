from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).parents[1] / "custom_components" / "urdash" / "style_presets.py"
SPEC = importlib.util.spec_from_file_location("urdash_style_presets", MODULE_PATH)
assert SPEC and SPEC.loader
style_presets = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(style_presets)


class StylePresetTests(unittest.TestCase):
    def test_catalog_includes_auto_and_mainstream_styles(self):
        expected = {
            "auto", "minimal", "aurora", "glassmorphism", "bento", "editorial",
            "material", "neobrutalist", "futuristic", "organic", "monochrome",
            "luxury", "playful",
        }
        self.assertEqual(expected, set(style_presets.STYLE_PRESETS))

    def test_auto_preserves_configured_renderer_theme(self):
        theme, guidance = style_presets.resolve_style("auto", "sunrise")
        self.assertEqual("sunrise", theme)
        self.assertIn("Choose", guidance)

    def test_preset_resolves_renderer_theme_and_guidance(self):
        theme, guidance = style_presets.resolve_style("minimal", "aurora")
        self.assertEqual("quiet", theme)
        self.assertIn("typography", guidance)

    def test_unknown_style_falls_back_safely(self):
        theme, _ = style_presets.resolve_style("unknown", "calm")
        self.assertEqual("calm", theme)


if __name__ == "__main__":
    unittest.main()
