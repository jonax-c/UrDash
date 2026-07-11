from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest


ROOT = Path(__file__).parents[1]


def load_module(name: str, relative_path: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


package = types.ModuleType("urdash")
package.__path__ = [str(ROOT / "custom_components" / "urdash")]
sys.modules.setdefault("urdash", package)
load_module("urdash.action_policy", "custom_components/urdash/action_policy.py")
validator = load_module("urdash.card_validator", "custom_components/urdash/card_validator.py")
SCHEMA = json.loads(
    (ROOT / "custom_components/urdash/frontend/card-schema-v2.json").read_text(encoding="utf-8")
)


def base_card(blocks: list[dict] | None = None) -> dict:
    return {
        "type": "custom:urdash-card",
        "urdash_schema": 2,
        "height_mode": "auto",
        "card": {
            "intent": {
                "goal": "sensor_summary",
                "title": "Test Card",
                "summary": "A validator fixture.",
                "risk_level": "low",
                "primary_entities": ["sensor.temperature"],
                "primary_actions": [],
            },
            "layout": {
                "type": "grid",
                "columns": 12,
                "blocks": blocks
                if blocks is not None
                else [
                    {
                        "id": "temperature",
                        "kind": "value",
                        "entity": "sensor.temperature",
                        "bind": {"value": "state", "unit": "attributes.unit_of_measurement"},
                        "grid": {"col": 1, "row": 1, "w": 6, "h": 2},
                    }
                ],
            },
        },
    }


ENTITIES = [
    {
        "entity_id": "sensor.temperature",
        "domain": "sensor",
        "state": "24",
        "attributes": {"unit_of_measurement": "°C"},
    },
    {
        "entity_id": "fan.bedroom",
        "domain": "fan",
        "state": "on",
        "attributes": {"supported_features": 0},
    },
    {
        "entity_id": "weather.home",
        "domain": "weather",
        "state": "partlycloudy",
        "attributes": {"supported_features": 1, "temperature": 27},
    },
    {
        "entity_id": "light.desk",
        "domain": "light",
        "state": "on",
        "attributes": {"supported_features": 0, "supported_color_modes": ["brightness"], "brightness": 180},
    },
]


def errors(card: dict, services: set[str] | None = None) -> list[dict]:
    return validator.validate_card_config(
        card,
        SCHEMA,
        entities=ENTITIES,
        available_services=services,
    )


class CardValidatorTests(unittest.TestCase):
    def test_strict_provider_schema_requires_all_properties_as_nullable(self):
        strict = validator.build_strict_provider_schema(SCHEMA)
        self.assertEqual(
            set(strict["required"]),
            set(strict["properties"]),
        )
        self.assertFalse(strict["additionalProperties"])
        self.assertIn("anyOf", strict["properties"]["height"])
        self.assertIn({"type": "null"}, strict["properties"]["height"]["anyOf"])
        pending = [strict]
        while pending:
            node = pending.pop()
            if not isinstance(node, dict):
                continue
            if node.get("type") == "object":
                self.assertFalse(node.get("additionalProperties"))
                self.assertEqual(set(node.get("required", [])), set(node.get("properties", {})))
            pending.extend(node.get("anyOf", []))
            if isinstance(node.get("items"), dict):
                pending.append(node["items"])
            pending.extend(node.get("properties", {}).values())
        self.assertEqual(
            validator.strip_provider_nulls(
                {"required": 1, "optional": None, "nested": {"empty": None}}
            ),
            {"required": 1, "nested": {}},
        )

    def test_v2_minor_migration_is_non_destructive(self):
        original = base_card()
        migrated = validator.migrate_card_config(original)
        self.assertEqual(migrated["urdash_schema_minor"], 0)
        self.assertNotIn("urdash_schema_minor", original)

    def test_valid_card_has_no_diagnostics(self):
        self.assertEqual(errors(base_card()), [])

    def test_structural_error_has_path_code_and_suggestion(self):
        card = base_card()
        card["unsafe"] = "<script>alert(1)</script>"
        diagnostic = errors(card)[0]
        self.assertEqual(diagnostic["path"], "$.unsafe")
        self.assertEqual(diagnostic["code"], "schema.additional_property")
        self.assertTrue(diagnostic["suggestion"])

    def test_missing_entities_duplicate_ids_and_grid_overflow_are_rejected(self):
        blocks = [
            {
                "id": "duplicate",
                "kind": "value",
                "entity": "sensor.missing",
                "grid": {"col": 11, "row": 1, "w": 4, "h": 1},
            },
            {"id": "duplicate", "kind": "text", "text": "Second"},
        ]
        diagnostics = errors(base_card(blocks))
        codes = {item["code"] for item in diagnostics}
        self.assertIn("semantic.missing_entity", codes)
        self.assertIn("semantic.duplicate_id", codes)
        self.assertIn("layout.grid_overflow", codes)

    def test_invalid_binding_is_rejected(self):
        card = base_card()
        card["card"]["layout"]["blocks"][0]["bind"]["value"] = "constructor.prototype"
        self.assertIn("semantic.invalid_binding", {item["code"] for item in errors(card)})

    def test_action_requires_entity_capability_and_registered_service(self):
        card = base_card(
            [
                {
                    "id": "fan",
                    "kind": "button",
                    "entity": "fan.bedroom",
                    "action": {
                        "type": "service",
                        "domain": "fan",
                        "service": "set_percentage",
                        "entity_id": "fan.bedroom",
                        "data": {"percentage": 50},
                    },
                }
            ]
        )
        diagnostics = errors(card, {"fan.set_percentage"})
        self.assertIn("action.unsupported_capability", {item["code"] for item in diagnostics})

        ENTITIES[1]["attributes"]["supported_features"] = 1
        try:
            diagnostics = errors(card, set())
            self.assertIn("action.unavailable_service", {item["code"] for item in diagnostics})
        finally:
            ENTITIES[1]["attributes"]["supported_features"] = 0

    def test_visual_map_links_must_reference_declared_nodes(self):
        card = base_card(
            [
                {
                    "id": "map",
                    "kind": "visual_map",
                    "nodes": [
                        {
                            "id": "source",
                            "label": "Source",
                            "position": {"x": 10, "y": 10},
                        }
                    ],
                    "links": [
                        {
                            "from": "source",
                            "to": "missing",
                        }
                    ],
                }
            ]
        )
        self.assertIn("semantic.missing_node", {item["code"] for item in errors(card)})

    def test_unsafe_vector_path_is_rejected(self):
        card = base_card(
            [
                {
                    "id": "icon",
                    "kind": "vector_icon",
                    "shapes": [
                        {
                            "type": "path",
                            "d": "M0 0 javascript:alert(1)",
                        }
                    ],
                }
            ]
        )
        self.assertIn("semantic.invalid_path_data", {item["code"] for item in errors(card)})

    def test_block_budget_is_enforced(self):
        blocks = [{"id": f"block-{index}", "kind": "text", "text": "x"} for index in range(65)]
        self.assertIn("budget.blocks", {item["code"] for item in errors(base_card(blocks))})

    def test_expression_reads_nested_attributes_and_aggregates_entities(self):
        card = base_card()
        card["card"]["layout"]["blocks"][0]["bind"]["value"] = {
            "op": "average",
            "args": [
                {"op": "entity", "entity_id": "sensor.temperature", "path": "state"},
                {"op": "entity", "entity_id": "sensor.temperature", "path": "attributes.calibration.offset"},
            ],
        }
        ENTITIES[0]["attributes"]["calibration"] = {"offset": 2}
        try:
            self.assertEqual(errors(card), [])
        finally:
            ENTITIES[0]["attributes"].pop("calibration")

    def test_expression_supports_visibility_mapping_and_action_parameters(self):
        card = base_card(
            [
                {
                    "id": "mapped",
                    "kind": "button",
                    "entity": "fan.bedroom",
                    "label": {
                        "op": "map",
                        "args": [{"op": "entity", "entity_id": "fan.bedroom", "path": "state"}],
                        "cases": [{"when": "on", "value": {"op": "literal", "value": "Cooling"}}],
                        "default": {"op": "literal", "value": "Idle"},
                    },
                    "visibility": {
                        "expression": {
                            "op": "eq",
                            "args": [
                                {"op": "entity", "entity_id": "fan.bedroom", "path": "state"},
                                {"op": "literal", "value": "on"},
                            ],
                        }
                    },
                    "action": {
                        "type": "service",
                        "domain": "fan",
                        "service": "set_percentage",
                        "entity_id": "fan.bedroom",
                        "data": {
                            "percentage": {
                                "op": "clamp",
                                "args": [{"op": "local", "name": "selected"}],
                                "min": 0,
                                "max": 100,
                            }
                        },
                    },
                }
            ]
        )
        ENTITIES[1]["attributes"]["supported_features"] = 1
        try:
            self.assertEqual(errors(card, {"fan.set_percentage"}), [])
        finally:
            ENTITIES[1]["attributes"]["supported_features"] = 0

    def test_expression_rejects_unsafe_paths_and_enforces_budgets(self):
        card = base_card()
        block = card["card"]["layout"]["blocks"][0]
        block["bind"]["value"] = {
            "op": "entity",
            "entity_id": "sensor.temperature",
            "path": "attributes.constructor.prototype",
        }
        self.assertIn("expression.invalid_path", {item["code"] for item in errors(card)})

        expression = {"op": "literal", "value": 1}
        for _ in range(9):
            expression = {"op": "not", "args": [expression]}
        block["bind"]["value"] = expression
        self.assertIn("expression.depth_budget", {item["code"] for item in errors(card)})

    def test_expression_schema_references_are_strict_and_resolvable(self):
        self.assertIn("expression", SCHEMA["$defs"])
        strict = validator.build_strict_provider_schema(SCHEMA)
        self.assertIn("expression", strict["$defs"])
        self.assertEqual(strict["$defs"]["expression"]["properties"]["args"]["anyOf"][0]["items"]["$ref"], "#/$defs/expression")

    def test_weather_forecast_source_and_expression_are_validated(self):
        card = base_card()
        card["card"]["data_sources"] = [
            {
                "id": "home_daily",
                "type": "weather_forecast",
                "entity": "weather.home",
                "forecast_type": "daily",
                "limit": 5,
            }
        ]
        card["card"]["layout"]["blocks"][0]["bind"]["value"] = {
            "op": "concat",
            "args": [
                {"op": "source", "source_id": "home_daily", "path": "forecast.0.temperature"},
                {"op": "literal", "value": "° / "},
                {"op": "source", "source_id": "home_daily", "path": "forecast.0.templow"},
                {"op": "literal", "value": "°"},
            ],
        }
        self.assertEqual(errors(card), [])

        card["card"]["data_sources"][0]["forecast_type"] = "hourly"
        codes = {item["code"] for item in errors(card)}
        self.assertIn("data_source.unsupported_forecast", codes)

        card["card"]["data_sources"][0]["forecast_type"] = "daily"
        card["card"]["layout"]["blocks"][0]["bind"]["value"] = {
            "op": "source",
            "source_id": "missing",
            "path": "forecast.99.constructor",
        }
        codes = {item["code"] for item in errors(card)}
        self.assertIn("expression.missing_source", codes)
        self.assertIn("expression.invalid_source_path", codes)

    def test_reusable_icon_sets_support_dynamic_keys_and_validate_assets(self):
        card = base_card()
        card["card"]["assets"] = {
            "icon_sets": [
                {
                    "id": "weather_icons",
                    "variants": [
                        {"key": "sunny", "icon": "mdi:weather-sunny"},
                        {
                            "key": "rainy",
                            "vector_icon": {
                                "viewBox": "0 0 100 100",
                                "shapes": [{"type": "circle", "cx": 50, "cy": 50, "r": 20}],
                            },
                        },
                    ],
                    "fallback": {"icon": "mdi:weather-cloudy-alert"},
                }
            ]
        }
        block = card["card"]["layout"]["blocks"][0]
        block["icon_ref"] = {
            "set": "weather_icons",
            "key": {"op": "entity", "entity_id": "weather.home", "path": "state"},
        }
        self.assertEqual(errors(card), [])

        block["icon_ref"] = {"set": "missing", "key": "sunny"}
        self.assertIn("asset.missing_set", {item["code"] for item in errors(card)})

        block["icon_ref"] = {"set": "weather_icons", "key": "sunny"}
        card["card"]["assets"]["icon_sets"][0]["variants"][0]["vector_icon"] = {
            "shapes": [{"type": "circle", "cx": 1, "cy": 1, "r": 1}]
        }
        self.assertIn("asset.invalid_variant", {item["code"] for item in errors(card)})

    def test_component_tree_composes_safe_bubble_controls(self):
        card = base_card(
            [
                {
                    "id": "desk-bubble",
                    "kind": "component_tree",
                    "component": {
                        "id": "surface",
                        "type": "surface",
                        "entity": "light.desk",
                        "action": {"type": "service", "domain": "light", "service": "toggle", "entity_id": "light.desk"},
                        "style": {"surface": "solid", "shape": "pill", "accent": "#f6c453"},
                        "layout": {"width": "fill", "padding": "md", "gap": "md", "align": "center"},
                        "children": [
                            {"type": "icon", "icon": "mdi:desk-lamp"},
                            {
                                "type": "column",
                                "layout": {"grow": 1, "gap": "xs"},
                                "children": [
                                    {"type": "text", "text": "Desk light", "style": {"emphasis": "high"}},
                                    {"type": "value", "entity": "light.desk", "bind": {"value": "state"}},
                                ],
                            },
                            {
                                "type": "toggle",
                                "entity": "light.desk",
                                "action": {"type": "service", "domain": "light", "service": "toggle", "entity_id": "light.desk"},
                            },
                        ],
                    },
                }
            ]
        )
        self.assertEqual(errors(card, {"light.toggle"}), [])

        slider = card["card"]["layout"]["blocks"][0]["component"]["children"][1]
        slider["type"] = "slider"
        slider.pop("children")
        diagnostics = errors(card, {"light.toggle"})
        self.assertIn("component.missing_action", {item["code"] for item in diagnostics})

    def test_component_tree_depth_budget_is_enforced(self):
        node = {"type": "text", "text": "deep"}
        for _ in range(7):
            node = {"type": "column", "children": [node]}
        card = base_card([{"id": "deep", "kind": "component_tree", "component": node}])
        self.assertIn("budget.component_depth", {item["code"] for item in errors(card)})


if __name__ == "__main__":
    unittest.main()
