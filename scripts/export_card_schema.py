from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import sys
import types

ROOT = Path(__file__).parents[1]
OUTPUT = ROOT / "custom_components" / "urdash" / "frontend" / "card-schema-v2.json"


def load_card_schema() -> dict:
    """Load CARD_V2_SCHEMA without requiring a local Home Assistant install."""
    homeassistant = types.ModuleType("homeassistant")
    core = types.ModuleType("homeassistant.core")
    core.HomeAssistant = object
    helpers = types.ModuleType("homeassistant.helpers")
    aiohttp_client = types.ModuleType("homeassistant.helpers.aiohttp_client")
    aiohttp_client.async_get_clientsession = lambda hass: None
    sys.modules.update(
        {
            "homeassistant": homeassistant,
            "homeassistant.core": core,
            "homeassistant.helpers": helpers,
            "homeassistant.helpers.aiohttp_client": aiohttp_client,
        }
    )

    package = types.ModuleType("urdash")
    package.__path__ = [str(ROOT / "custom_components" / "urdash")]
    sys.modules["urdash"] = package
    for name in ("const", "action_policy", "capabilities"):
        _load_module(f"urdash.{name}", ROOT / "custom_components" / "urdash" / f"{name}.py")
    ai_client = _load_module(
        "urdash.ai_client",
        ROOT / "custom_components" / "urdash" / "ai_client.py",
    )
    return ai_client.CARD_V2_SCHEMA


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def rendered_schema() -> str:
    return json.dumps(
        load_card_schema(),
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    expected = rendered_schema()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text(encoding="utf-8") != expected:
            print(f"Schema artifact is stale: {OUTPUT}", file=sys.stderr)
            return 1
        return 0
    OUTPUT.write_text(expected, encoding="utf-8")
    print(f"Wrote {OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
