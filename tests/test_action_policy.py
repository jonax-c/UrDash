from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

from jsonschema import Draft202012Validator


ROOT = Path(__file__).parents[1]


def load_module(name: str, relative_path: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


action_policy = load_module("urdash_action_policy", "custom_components/urdash/action_policy.py")
capabilities = load_module("urdash_capabilities_for_policy", "custom_components/urdash/capabilities.py")


def entity(domain: str) -> dict:
    attributes = {
        "supported_features": (1 << 22) - 1,
        "supported_color_modes": ["color_temp", "rgb"],
        "effect_list": ["rainbow"],
        "hvac_modes": ["off", "cool"],
        "fan_modes": ["auto"],
        "preset_modes": ["eco"],
        "swing_modes": ["off"],
        "swing_horizontal_modes": ["off"],
        "source_list": ["TV"],
        "sound_mode_list": ["Cinema"],
        "options": ["one"],
        "fan_speed_list": ["quiet"],
        "available_modes": ["auto"],
        "operation_list": ["eco"],
        "activity_list": ["Watch TV"],
        "available_tones": ["alarm"],
    }
    return {
        "entity_id": f"{domain}.test",
        "domain": domain,
        "state": "on",
        "attributes": attributes,
    }


class ActionPolicyTests(unittest.TestCase):
    def test_manifest_and_generated_schema_are_valid(self):
        self.assertEqual(action_policy.ACTION_MANIFEST["version"], 1)
        self.assertGreaterEqual(len(action_policy.ACTION_MANIFEST["domains"]), 25)
        Draft202012Validator.check_schema(action_policy.ACTION_SCHEMA)
        self.assertFalse(action_policy.ACTION_SCHEMA["additionalProperties"])
        self.assertFalse(action_policy.ACTION_SCHEMA["properties"]["data"]["additionalProperties"])

    def test_every_capability_operation_has_a_manifest_policy(self):
        missing: list[str] = []
        for domain in action_policy.ACTION_MANIFEST["domains"]:
            descriptor = capabilities.build_entity_capability_descriptor(entity(domain))
            for capability in descriptor["capabilities"]:
                capability_domain, service = capability["service"].split(".", 1)
                if action_policy.get_service_policy(
                    action_policy.ACTION_MANIFEST,
                    capability_domain,
                    service,
                ) is None:
                    missing.append(capability["service"])
        self.assertEqual(missing, [])

    def test_ai_schema_contains_manifest_domains_services_and_parameters(self):
        schema = action_policy.ACTION_SCHEMA
        self.assertEqual(
            set(schema["properties"]["domain"]["enum"]),
            set(action_policy.ACTION_MANIFEST["domains"]),
        )
        self.assertIn("alarm_disarm", schema["properties"]["service"]["enum"])
        self.assertIn("rgb_color", schema["properties"]["data"]["properties"])
        self.assertIn("swing_horizontal_mode", schema["properties"]["data"]["properties"])

    def test_high_risk_operations_declare_confirmation(self):
        missing_confirmation = []
        for domain, domain_policy in action_policy.ACTION_MANIFEST["domains"].items():
            for service, policy in domain_policy["services"].items():
                if policy["risk"] == "high" and policy.get("confirmation") is not True:
                    missing_confirmation.append(f"{domain}.{service}")
        self.assertEqual(missing_confirmation, [])

    def test_required_parameters_exist_in_parameter_contract(self):
        for domain, domain_policy in action_policy.ACTION_MANIFEST["domains"].items():
            for service, policy in domain_policy["services"].items():
                parameters = policy.get("parameters", {})
                for name in policy.get("required", []):
                    with self.subTest(service=f"{domain}.{service}", parameter=name):
                        self.assertIn(name, parameters)
                for group in policy.get("required_any", []):
                    with self.subTest(service=f"{domain}.{service}", group=group):
                        self.assertTrue(group)
                        self.assertTrue(all(name in parameters for name in group))


if __name__ == "__main__":
    unittest.main()
