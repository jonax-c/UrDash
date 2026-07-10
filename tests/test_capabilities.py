from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).parents[1] / "custom_components" / "urdash" / "capabilities.py"
SPEC = importlib.util.spec_from_file_location("urdash_capabilities", MODULE_PATH)
assert SPEC and SPEC.loader
capabilities = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(capabilities)


def entity(entity_id: str, state: str, attributes: dict | None = None, **metadata):
    return {
        "entity_id": entity_id,
        "domain": entity_id.split(".", 1)[0],
        "state": state,
        "attributes": attributes or {},
        **metadata,
    }


def operation(descriptor: dict, operation_id: str) -> dict:
    return next(item for item in descriptor["capabilities"] if item["id"] == operation_id)


class CapabilityDescriptorTests(unittest.TestCase):
    def test_light_exposes_only_supported_color_controls(self):
        descriptor = capabilities.build_entity_capability_descriptor(
            entity(
                "light.desk",
                "on",
                {
                    "friendly_name": "Desk Light",
                    "supported_color_modes": ["color_temp", "rgb"],
                    "min_color_temp_kelvin": 2200,
                    "max_color_temp_kelvin": 6500,
                    "effect_list": ["rainbow", "candle"],
                    "brightness": 180,
                    "rgb_color": [120, 180, 255],
                },
                device_id="device-1",
                area_id="office",
                area_name="Office",
            )
        )

        self.assertEqual(descriptor["capability_schema"], 1)
        self.assertEqual(descriptor["name"], "Desk Light")
        self.assertEqual(descriptor["device_id"], "device-1")
        self.assertEqual(descriptor["area_name"], "Office")
        self.assertEqual(descriptor["display"]["rgb_color"], [120, 180, 255])
        parameters = operation(descriptor, "turn_on")["parameters"]
        self.assertEqual(parameters["brightness_pct"]["max"], 100)
        self.assertEqual(parameters["color_temp_kelvin"]["min"], 2200)
        self.assertEqual(parameters["rgb_color"]["type"], "rgb")
        self.assertEqual(parameters["effect"]["options"], ["rainbow", "candle"])

    def test_climate_features_define_ranges_and_modes(self):
        supported = sum(capabilities.CLIMATE_FEATURES.values())
        descriptor = capabilities.build_entity_capability_descriptor(
            entity(
                "climate.living_room",
                "cool",
                {
                    "supported_features": supported,
                    "unit_of_measurement": "°C",
                    "min_temp": 16,
                    "max_temp": 30,
                    "target_temp_step": 0.5,
                    "min_humidity": 35,
                    "max_humidity": 70,
                    "target_humidity_step": 5,
                    "hvac_modes": ["off", "cool", "heat_cool"],
                    "fan_modes": ["auto", "low", "high"],
                    "preset_modes": ["eco", "comfort"],
                    "swing_modes": ["off", "vertical"],
                    "swing_horizontal_modes": ["off", "wide"],
                },
            )
        )

        temperature = operation(descriptor, "set_temperature")["parameters"]
        self.assertEqual(temperature["temperature"]["step"], 0.5)
        self.assertIn("target_temp_low", temperature)
        self.assertIn("target_temp_high", temperature)
        humidity = operation(descriptor, "set_humidity")["parameters"]["humidity"]
        self.assertEqual((humidity["min"], humidity["max"], humidity["step"]), (35, 70, 5))
        self.assertEqual(
            operation(descriptor, "set_fan_mode")["parameters"]["fan_mode"]["options"],
            ["auto", "low", "high"],
        )

    def test_service_registry_filters_unavailable_operations(self):
        descriptor = capabilities.build_entity_capability_descriptor(
            entity(
                "fan.bedroom",
                "on",
                {
                    "supported_features": sum(capabilities.FAN_FEATURES.values()),
                    "percentage_step": 5,
                    "preset_modes": ["sleep", "auto"],
                },
            ),
            {"fan.turn_on", "fan.turn_off", "fan.set_percentage"},
        )

        operations = {item["id"] for item in descriptor["capabilities"]}
        self.assertEqual(operations, {"turn_on", "turn_off", "set_percentage"})
        self.assertEqual(operation(descriptor, "set_percentage")["parameters"]["percentage"]["step"], 5)

    def test_garage_opening_and_unlock_are_risky(self):
        garage = capabilities.build_entity_capability_descriptor(
            entity(
                "cover.garage",
                "closed",
                {
                    "device_class": "garage",
                    "supported_features": capabilities.COVER_FEATURES["open"] | capabilities.COVER_FEATURES["close"],
                },
            )
        )
        lock = capabilities.build_entity_capability_descriptor(entity("lock.front_door", "locked"))

        self.assertEqual(operation(garage, "open")["risk"], "medium")
        self.assertEqual(operation(garage, "close")["risk"], "low")
        self.assertEqual(operation(lock, "unlock")["risk"], "high")

    def test_media_player_uses_feature_flags_and_source_options(self):
        supported = (
            capabilities.MEDIA_PLAYER_FEATURES["pause"]
            | capabilities.MEDIA_PLAYER_FEATURES["seek"]
            | capabilities.MEDIA_PLAYER_FEATURES["volume_set"]
            | capabilities.MEDIA_PLAYER_FEATURES["volume_mute"]
            | capabilities.MEDIA_PLAYER_FEATURES["select_source"]
        )
        descriptor = capabilities.build_entity_capability_descriptor(
            entity(
                "media_player.lounge",
                "playing",
                {
                    "supported_features": supported,
                    "media_duration": 242,
                    "source_list": ["TV", "Music", "Radio"],
                },
            )
        )

        self.assertEqual(operation(descriptor, "seek")["parameters"]["seek_position"]["max"], 242)
        self.assertEqual(
            operation(descriptor, "select_source")["parameters"]["source"]["options"],
            ["TV", "Music", "Radio"],
        )
        self.assertEqual(operation(descriptor, "set_muted")["parameters"]["is_volume_muted"]["type"], "boolean")

    def test_water_heater_and_remote_expose_bounded_parameters(self):
        water_heater = capabilities.build_entity_capability_descriptor(
            entity(
                "water_heater.tank",
                "eco",
                {
                    "min_temp": 40,
                    "max_temp": 65,
                    "target_temp_step": 0.5,
                    "unit_of_measurement": "°C",
                    "operation_list": ["eco", "performance"],
                },
            )
        )
        remote = capabilities.build_entity_capability_descriptor(
            entity(
                "remote.lounge",
                "on",
                {
                    "supported_features": capabilities.REMOTE_FEATURE_ACTIVITY,
                    "activity_list": ["Watch TV", "Music"],
                },
            )
        )

        temperature = operation(water_heater, "set_temperature")["parameters"]["temperature"]
        self.assertEqual((temperature["min"], temperature["max"], temperature["step"]), (40, 65, 0.5))
        self.assertEqual(
            operation(water_heater, "set_operation_mode")["parameters"]["operation_mode"]["options"],
            ["eco", "performance"],
        )
        self.assertEqual(
            operation(remote, "turn_on")["parameters"]["activity"]["options"],
            ["Watch TV", "Music"],
        )
        self.assertEqual(operation(remote, "send_command")["risk"], "medium")
        self.assertEqual(operation(remote, "send_command")["parameters"]["command"]["max_items"], 16)

    def test_unknown_domain_remains_display_only(self):
        descriptor = capabilities.build_entity_capability_descriptor(
            entity(
                "sensor.custom_metric",
                "42",
                {"device_class": "power", "unit_of_measurement": "W"},
            )
        )

        self.assertEqual(descriptor["capabilities"], [])
        self.assertEqual(descriptor["display"]["unit_of_measurement"], "W")
        self.assertTrue(descriptor["available"])

    def test_unknown_and_unavailable_states_are_not_available(self):
        for state in ("unknown", "unavailable"):
            with self.subTest(state=state):
                descriptor = capabilities.build_entity_capability_descriptor(entity("sensor.test", state))
                self.assertFalse(descriptor["available"])

    def test_all_explicitly_selected_entities_are_preserved(self):
        entities = [entity(f"sensor.sample_{index}", str(index)) for index in range(300)]
        descriptors = capabilities.build_entity_capability_descriptors(entities)

        self.assertEqual(len(descriptors), 300)
        self.assertEqual(descriptors[-1]["entity_id"], "sensor.sample_299")

    def test_enum_options_have_a_deterministic_budget(self):
        options = [f"option-{index}" for index in range(100)]
        descriptor = capabilities.build_entity_capability_descriptor(
            entity("select.mode", "option-0", {"options": options})
        )

        values = operation(descriptor, "select_option")["parameters"]["option"]["options"]
        self.assertEqual(len(values), capabilities.MAX_OPTIONS)
        self.assertEqual(values[-1], "option-63")


if __name__ == "__main__":
    unittest.main()
