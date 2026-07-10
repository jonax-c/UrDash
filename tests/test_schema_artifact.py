from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "scripts" / "export_card_schema.py"
SPEC = importlib.util.spec_from_file_location("export_card_schema", SCRIPT)
assert SPEC and SPEC.loader
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


class SchemaArtifactTests(unittest.TestCase):
    def test_frontend_schema_artifact_matches_python_source(self):
        artifact = json.loads(exporter.OUTPUT.read_text(encoding="utf-8"))
        self.assertEqual(artifact, exporter.load_card_schema())


if __name__ == "__main__":
    unittest.main()
