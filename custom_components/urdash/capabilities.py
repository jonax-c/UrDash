from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

CAPABILITY_DESCRIPTOR_VERSION = 1
MAX_OPTIONS = 64

UNAVAILABLE_STATES = {"unknown", "unavailable"}

# Home Assistant EntityFeature values are stable wire-level state attributes.
# Keep these local so capability normalization remains testable without HA imports.
FAN_FEATURES = {
    "set_speed": 1,
    "oscillate": 2,
    "direction": 4,
    "preset_mode": 8,
    "turn_off": 16,
    "turn_on": 32,
}
CLIMATE_FEATURES = {
    "target_temperature": 1,
    "target_temperature_range": 2,
    "target_humidity": 4,
    "fan_mode": 8,
    "preset_mode": 16,
    "swing_mode": 32,
    "turn_off": 128,
    "turn_on": 256,
    "swing_horizontal_mode": 512,
}
COVER_FEATURES = {
    "open": 1,
    "close": 2,
    "set_position": 4,
    "stop": 8,
    "open_tilt": 16,
    "close_tilt": 32,
    "stop_tilt": 64,
    "set_tilt_position": 128,
}
MEDIA_PLAYER_FEATURES = {
    "pause": 1,
    "seek": 2,
    "volume_set": 4,
    "volume_mute": 8,
    "previous_track": 16,
    "next_track": 32,
    "turn_on": 128,
    "turn_off": 256,
    "play_media": 512,
    "volume_step": 1024,
    "select_source": 2048,
    "stop": 4096,
    "play": 16384,
    "shuffle_set": 32768,
    "select_sound_mode": 65536,
    "browse_media": 131072,
    "repeat_set": 262144,
}
ALARM_FEATURES = {
    "arm_home": 1,
    "arm_away": 2,
    "arm_night": 4,
    "trigger": 8,
    "arm_custom_bypass": 16,
    "arm_vacation": 32,
}
VACUUM_FEATURES = {
    "pause": 4,
    "stop": 8,
    "return_home": 16,
    "fan_speed": 32,
    "send_command": 256,
    "locate": 512,
    "clean_spot": 1024,
    "start": 8192,
    "clean_area": 16384,
}
VALVE_FEATURES = {"open": 1, "close": 2, "set_position": 4, "stop": 8}
LAWN_MOWER_FEATURES = {"start_mowing": 1, "pause": 2, "dock": 4}
UPDATE_FEATURES = {"install": 1, "specific_version": 2, "progress": 4, "backup": 8, "release_notes": 16}
REMOTE_FEATURE_ACTIVITY = 4
WEATHER_FEATURES = {"daily": 1, "hourly": 2, "twice_daily": 4}

DISPLAY_ATTRIBUTES = {
    "battery_level",
    "apparent_temperature",
    "brightness",
    "cloud_coverage",
    "color_mode",
    "color_temp_kelvin",
    "current_humidity",
    "current_position",
    "current_temperature",
    "dew_point",
    "current_tilt_position",
    "device_class",
    "direction",
    "effect",
    "fan_mode",
    "humidity",
    "hs_color",
    "hvac_action",
    "installed_version",
    "is_volume_muted",
    "latest_version",
    "media_album_name",
    "media_artist",
    "media_duration",
    "media_position",
    "media_title",
    "oscillating",
    "operation_mode",
    "percentage",
    "preset_mode",
    "release_summary",
    "rgb_color",
    "source",
    "swing_horizontal_mode",
    "swing_mode",
    "temperature",
    "temperature_unit",
    "precipitation_unit",
    "pressure",
    "pressure_unit",
    "target_temp_high",
    "target_temp_low",
    "unit_of_measurement",
    "uv_index",
    "visibility",
    "visibility_unit",
    "update_percentage",
    "volume_level",
    "wind_bearing",
    "wind_gust_speed",
    "wind_speed",
    "wind_speed_unit",
    "xy_color",
}


def build_entity_capability_descriptors(
    entities: Iterable[Mapping[str, Any]],
    available_services: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Build compact, versioned AI capability descriptors for HA entities."""
    return [build_entity_capability_descriptor(entity, available_services) for entity in entities]


def build_entity_capability_descriptor(
    entity: Mapping[str, Any],
    available_services: set[str] | None = None,
) -> dict[str, Any]:
    """Normalize one serialized HA state into a safe capability descriptor."""
    entity_id = str(entity.get("entity_id") or "")
    domain = str(entity.get("domain") or entity_id.partition(".")[0])
    attributes = entity.get("attributes") if isinstance(entity.get("attributes"), Mapping) else {}
    state = str(entity.get("state") or "unknown")
    supported_features = _as_int(attributes.get("supported_features"), 0)

    descriptor: dict[str, Any] = {
        "capability_schema": CAPABILITY_DESCRIPTOR_VERSION,
        "entity_id": entity_id,
        "domain": domain,
        "name": entity.get("name") or attributes.get("friendly_name") or entity_id,
        "state": state,
        "available": state not in UNAVAILABLE_STATES,
        "supported_features": supported_features,
        "capabilities": [],
    }
    _copy_optional(
        descriptor,
        entity,
        ("device_id", "device_name", "area_id", "area_name"),
    )
    _copy_optional(
        descriptor,
        attributes,
        ("device_class", "unit_of_measurement", "assumed_state"),
    )
    display = {
        key: attributes[key]
        for key in DISPLAY_ATTRIBUTES
        if key in attributes and _is_compact_value(attributes[key])
    }
    if display:
        descriptor["display"] = display

    capabilities: list[dict[str, Any]] = descriptor["capabilities"]

    if domain == "weather":
        descriptor["data_sources"] = [
            {
                "type": "weather_forecast",
                "forecast_types": [
                    name for name, flag in WEATHER_FEATURES.items()
                    if _has_feature(supported_features, flag)
                ],
                "fields": [
                    "datetime", "condition", "temperature", "templow",
                    "precipitation", "precipitation_probability", "humidity",
                    "pressure", "cloud_coverage", "uv_index", "wind_bearing",
                    "wind_speed", "wind_gust_speed", "is_daytime",
                ],
            }
        ]

    def add(
        operation: str,
        service: str,
        *,
        parameters: dict[str, Any] | None = None,
        risk: str = "low",
        requires_user_code: bool = False,
    ) -> None:
        service_id = f"{domain}.{service}"
        if available_services is not None and service_id not in available_services:
            return
        capability: dict[str, Any] = {"id": operation, "service": service_id, "risk": risk}
        if parameters:
            capability["parameters"] = parameters
        if requires_user_code:
            capability["requires_user_code"] = True
        capabilities.append(capability)

    if domain == "light":
        params: dict[str, Any] = {}
        color_modes = _string_list(attributes.get("supported_color_modes"))
        if any(mode != "onoff" for mode in color_modes):
            params["brightness_pct"] = _number_parameter(0, 100, 1, "%")
        if "color_temp" in color_modes:
            params["color_temp_kelvin"] = _number_parameter(
                _as_number(attributes.get("min_color_temp_kelvin"), 2000),
                _as_number(attributes.get("max_color_temp_kelvin"), 6500),
                1,
                "K",
            )
        if any(mode in {"hs", "xy", "rgb", "rgbw", "rgbww"} for mode in color_modes):
            params["rgb_color"] = {"type": "rgb"}
        _add_options(params, "effect", attributes.get("effect_list"))
        add("turn_on", "turn_on", parameters=params)
        add("turn_off", "turn_off")
        add("toggle", "toggle")

    elif domain in {"switch", "input_boolean", "automation"}:
        add("turn_on", "turn_on")
        add("turn_off", "turn_off")
        add("toggle", "toggle")

    elif domain == "fan":
        if _has_feature(supported_features, FAN_FEATURES["turn_on"]) or not supported_features:
            add("turn_on", "turn_on")
        if _has_feature(supported_features, FAN_FEATURES["turn_off"]) or not supported_features:
            add("turn_off", "turn_off")
        if (
            _has_feature(supported_features, FAN_FEATURES["turn_on"] | FAN_FEATURES["turn_off"])
            or not supported_features
        ):
            add("toggle", "toggle")
        if _has_feature(supported_features, FAN_FEATURES["set_speed"]):
            step = _as_number(attributes.get("percentage_step"), 1)
            add("set_percentage", "set_percentage", parameters={"percentage": _number_parameter(0, 100, step, "%")})
        if _has_feature(supported_features, FAN_FEATURES["preset_mode"]):
            add(
                "set_preset_mode",
                "set_preset_mode",
                parameters={"preset_mode": _enum_parameter(attributes.get("preset_modes"))},
            )
        if _has_feature(supported_features, FAN_FEATURES["oscillate"]):
            add("set_oscillating", "oscillate", parameters={"oscillating": {"type": "boolean"}})
        if _has_feature(supported_features, FAN_FEATURES["direction"]):
            add("set_direction", "set_direction", parameters={"direction": _enum_parameter(["forward", "reverse"])})

    elif domain == "climate":
        if _has_feature(supported_features, CLIMATE_FEATURES["turn_on"]):
            add("turn_on", "turn_on")
        if _has_feature(supported_features, CLIMATE_FEATURES["turn_off"]):
            add("turn_off", "turn_off")
        hvac_modes = _string_list(attributes.get("hvac_modes"))
        if hvac_modes:
            add("set_hvac_mode", "set_hvac_mode", parameters={"hvac_mode": _enum_parameter(hvac_modes)})
        temp_params: dict[str, Any] = {}
        temp_range = _number_parameter(
            _as_number(attributes.get("min_temp"), 7),
            _as_number(attributes.get("max_temp"), 35),
            _as_number(attributes.get("target_temp_step"), 1),
            attributes.get("unit_of_measurement"),
        )
        if _has_feature(supported_features, CLIMATE_FEATURES["target_temperature"]):
            temp_params["temperature"] = temp_range
        if _has_feature(supported_features, CLIMATE_FEATURES["target_temperature_range"]):
            temp_params["target_temp_low"] = temp_range
            temp_params["target_temp_high"] = temp_range
        if temp_params:
            add("set_temperature", "set_temperature", parameters=temp_params)
        if _has_feature(supported_features, CLIMATE_FEATURES["target_humidity"]):
            add("set_humidity", "set_humidity", parameters={"humidity": _number_parameter(
                _as_number(attributes.get("min_humidity"), 30),
                _as_number(attributes.get("max_humidity"), 99),
                _as_number(attributes.get("target_humidity_step"), 1),
                "%",
            )})
        for feature, operation, service, attr, parameter in (
            ("fan_mode", "set_fan_mode", "set_fan_mode", "fan_modes", "fan_mode"),
            ("preset_mode", "set_preset_mode", "set_preset_mode", "preset_modes", "preset_mode"),
            ("swing_mode", "set_swing_mode", "set_swing_mode", "swing_modes", "swing_mode"),
            (
                "swing_horizontal_mode",
                "set_swing_horizontal_mode",
                "set_swing_horizontal_mode",
                "swing_horizontal_modes",
                "swing_horizontal_mode",
            ),
        ):
            if _has_feature(supported_features, CLIMATE_FEATURES[feature]):
                add(operation, service, parameters={parameter: _enum_parameter(attributes.get(attr))})

    elif domain == "cover":
        opening_risk = "medium" if attributes.get("device_class") in {"door", "garage", "gate"} else "low"
        for feature, operation, service, risk in (
            ("open", "open", "open_cover", opening_risk),
            ("close", "close", "close_cover", "low"),
            ("stop", "stop", "stop_cover", "low"),
            ("open_tilt", "open_tilt", "open_cover_tilt", "low"),
            ("close_tilt", "close_tilt", "close_cover_tilt", "low"),
            ("stop_tilt", "stop_tilt", "stop_cover_tilt", "low"),
        ):
            if _has_feature(supported_features, COVER_FEATURES[feature]):
                add(operation, service, risk=risk)
        if _has_feature(supported_features, COVER_FEATURES["set_position"]):
            add(
                "set_position",
                "set_cover_position",
                parameters={"position": _number_parameter(0, 100, 1, "%")},
                risk=opening_risk,
            )
        if _has_feature(supported_features, COVER_FEATURES["set_tilt_position"]):
            add(
                "set_tilt_position",
                "set_cover_tilt_position",
                parameters={"tilt_position": _number_parameter(0, 100, 1, "%")},
            )

    elif domain == "media_player":
        for feature, operation, service in (
            ("turn_on", "turn_on", "turn_on"),
            ("turn_off", "turn_off", "turn_off"),
            ("play", "play", "media_play"),
            ("pause", "pause", "media_pause"),
            ("stop", "stop", "media_stop"),
            ("previous_track", "previous_track", "media_previous_track"),
            ("next_track", "next_track", "media_next_track"),
        ):
            if _has_feature(supported_features, MEDIA_PLAYER_FEATURES[feature]):
                add(operation, service)
        if _has_feature(supported_features, MEDIA_PLAYER_FEATURES["pause"]):
            add("play_pause", "media_play_pause")
        if _has_feature(supported_features, MEDIA_PLAYER_FEATURES["volume_set"]):
            add("set_volume", "volume_set", parameters={"volume_level": _number_parameter(0, 1, 0.01)})
        if _has_feature(supported_features, MEDIA_PLAYER_FEATURES["volume_mute"]):
            add("set_muted", "volume_mute", parameters={"is_volume_muted": {"type": "boolean"}})
        if _has_feature(supported_features, MEDIA_PLAYER_FEATURES["seek"]):
            add(
                "seek",
                "media_seek",
                parameters={
                    "seek_position": _number_parameter(0, attributes.get("media_duration"), 1, "s")
                },
            )
        if _has_feature(supported_features, MEDIA_PLAYER_FEATURES["select_source"]):
            add("select_source", "select_source", parameters={"source": _enum_parameter(attributes.get("source_list"))})
        if _has_feature(supported_features, MEDIA_PLAYER_FEATURES["select_sound_mode"]):
            add(
                "select_sound_mode",
                "select_sound_mode",
                parameters={"sound_mode": _enum_parameter(attributes.get("sound_mode_list"))},
            )
        if _has_feature(supported_features, MEDIA_PLAYER_FEATURES["shuffle_set"]):
            add("set_shuffle", "shuffle_set", parameters={"shuffle": {"type": "boolean"}})
        if _has_feature(supported_features, MEDIA_PLAYER_FEATURES["repeat_set"]):
            add("set_repeat", "repeat_set", parameters={"repeat": _enum_parameter(["off", "one", "all"])})

    elif domain == "lock":
        add("lock", "lock")
        add("unlock", "unlock", risk="high")

    elif domain in {"scene", "script"}:
        add("activate" if domain == "scene" else "run", "turn_on", risk="low" if domain == "scene" else "medium")

    elif domain in {"button", "input_button"}:
        add("press", "press")

    elif domain in {"select", "input_select"}:
        options = attributes.get("options")
        add("select_option", "select_option", parameters={"option": _enum_parameter(options)})
        add("select_next", "select_next")
        add("select_previous", "select_previous")

    elif domain in {"number", "input_number"}:
        add("set_value", "set_value", parameters={"value": _number_parameter(
            _as_number(attributes.get("min"), 0),
            _as_number(attributes.get("max"), 100),
            _as_number(attributes.get("step"), 1),
            attributes.get("unit_of_measurement"),
        )})

    elif domain == "alarm_control_panel":
        has_code = bool(attributes.get("code_format"))
        arm_requires_code = has_code and bool(attributes.get("code_arm_required"))
        add("disarm", "alarm_disarm", risk="high", requires_user_code=has_code)
        for feature, operation, service in (
            ("arm_home", "arm_home", "alarm_arm_home"),
            ("arm_away", "arm_away", "alarm_arm_away"),
            ("arm_night", "arm_night", "alarm_arm_night"),
            ("arm_custom_bypass", "arm_custom_bypass", "alarm_arm_custom_bypass"),
            ("arm_vacation", "arm_vacation", "alarm_arm_vacation"),
            ("trigger", "trigger", "alarm_trigger"),
        ):
            if _has_feature(supported_features, ALARM_FEATURES[feature]):
                add(
                    operation,
                    service,
                    risk="high" if feature == "trigger" else "medium",
                    requires_user_code=arm_requires_code and feature != "trigger",
                )

    elif domain == "vacuum":
        for feature, operation, service, risk in (
            ("start", "start", "start", "low"),
            ("pause", "pause", "pause", "low"),
            ("stop", "stop", "stop", "low"),
            ("return_home", "return_home", "return_to_base", "low"),
            ("locate", "locate", "locate", "low"),
            ("clean_spot", "clean_spot", "clean_spot", "medium"),
        ):
            if _has_feature(supported_features, VACUUM_FEATURES[feature]):
                add(operation, service, risk=risk)
        if _has_feature(supported_features, VACUUM_FEATURES["fan_speed"]):
            add(
                "set_fan_speed",
                "set_fan_speed",
                parameters={"fan_speed": _enum_parameter(attributes.get("fan_speed_list"))},
            )

    elif domain == "valve":
        opening_risk = "medium" if attributes.get("device_class") in {"gas", "water"} else "low"
        for feature, operation, service, risk in (
            ("open", "open", "open_valve", opening_risk),
            ("close", "close", "close_valve", "low"),
            ("stop", "stop", "stop_valve", "low"),
        ):
            if _has_feature(supported_features, VALVE_FEATURES[feature]):
                add(operation, service, risk=risk)
        if _has_feature(supported_features, VALVE_FEATURES["set_position"]):
            add(
                "set_position",
                "set_valve_position",
                parameters={"position": _number_parameter(0, 100, 1, "%")},
                risk=opening_risk,
            )

    elif domain == "humidifier":
        add("turn_on", "turn_on")
        add("turn_off", "turn_off")
        add("set_humidity", "set_humidity", parameters={"humidity": _number_parameter(
            _as_number(attributes.get("min_humidity"), 0),
            _as_number(attributes.get("max_humidity"), 100),
            _as_number(attributes.get("target_humidity_step"), 1),
            "%",
        )})
        modes = attributes.get("available_modes")
        if _string_list(modes):
            add("set_mode", "set_mode", parameters={"mode": _enum_parameter(modes)})

    elif domain == "water_heater":
        add("turn_on", "turn_on")
        add("turn_off", "turn_off")
        add("set_temperature", "set_temperature", parameters={"temperature": _number_parameter(
            _as_number(attributes.get("min_temp"), 35),
            _as_number(attributes.get("max_temp"), 75),
            _as_number(attributes.get("target_temp_step"), 1),
            attributes.get("unit_of_measurement"),
        )})
        operation_modes = attributes.get("operation_list")
        if _string_list(operation_modes):
            add(
                "set_operation_mode",
                "set_operation_mode",
                parameters={"operation_mode": _enum_parameter(operation_modes)},
            )

    elif domain == "remote":
        activity_parameters: dict[str, Any] = {}
        if _has_feature(supported_features, REMOTE_FEATURE_ACTIVITY):
            _add_options(activity_parameters, "activity", attributes.get("activity_list"))
        add("turn_on", "turn_on", parameters=activity_parameters)
        add("turn_off", "turn_off", parameters=activity_parameters)
        add("toggle", "toggle", parameters=activity_parameters)
        add(
            "send_command",
            "send_command",
            parameters={
                "command": {"type": "array", "items": "string", "max_items": 16},
                "device": {"type": "string", "optional": True},
                "num_repeats": _number_parameter(1, 20, 1),
                "delay_secs": _number_parameter(0, 10, 0.1, "s"),
                "hold_secs": _number_parameter(0, 10, 0.1, "s"),
            },
            risk="medium",
        )

    elif domain == "siren":
        params: dict[str, Any] = {
            "duration": _number_parameter(1, 3600, 1, "s"),
            "volume_level": _number_parameter(0, 1, 0.01),
        }
        _add_options(params, "tone", attributes.get("available_tones"))
        add("turn_on", "turn_on", parameters=params, risk="high")
        add("turn_off", "turn_off")

    elif domain == "timer":
        add("start", "start", parameters={"duration": {"type": "duration"}})
        add("pause", "pause")
        add("cancel", "cancel")
        add("finish", "finish")

    elif domain == "update":
        if _has_feature(supported_features, UPDATE_FEATURES["install"]):
            params: dict[str, Any] = {}
            if _has_feature(supported_features, UPDATE_FEATURES["specific_version"]):
                params["version"] = {"type": "string"}
            if _has_feature(supported_features, UPDATE_FEATURES["backup"]):
                params["backup"] = {"type": "boolean"}
            add("install", "install", parameters=params, risk="high")
        add("skip", "skip", risk="medium")
        add("clear_skipped", "clear_skipped")

    elif domain == "lawn_mower":
        for feature, operation, service in (
            ("start_mowing", "start_mowing", "start_mowing"),
            ("pause", "pause", "pause"),
            ("dock", "dock", "dock"),
        ):
            if _has_feature(supported_features, LAWN_MOWER_FEATURES[feature]):
                add(operation, service, risk="medium" if feature == "start_mowing" else "low")

    elif domain == "counter":
        add("increment", "increment")
        add("decrement", "decrement")
        add("reset", "reset")
        add("set_value", "set_value", parameters={"value": {"type": "integer"}})

    return descriptor


def _copy_optional(target: dict[str, Any], source: Mapping[str, Any], keys: Iterable[str]) -> None:
    for key in keys:
        value = source.get(key)
        if value is not None and value != "":
            target[key] = value


def _is_compact_value(value: Any) -> bool:
    if isinstance(value, str | int | float | bool) or value is None:
        return True
    return (
        isinstance(value, list | tuple)
        and len(value) <= 8
        and all(isinstance(item, str | int | float | bool) or item is None for item in value)
    )


def _has_feature(features: int, flag: int) -> bool:
    return bool(features & flag)


def _as_int(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _as_number(value: Any, fallback: Any) -> float | int | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return int(number) if number.is_integer() else number


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list | tuple):
        return []
    return [str(item) for item in value[:MAX_OPTIONS] if isinstance(item, str | int | float)]


def _number_parameter(minimum: Any, maximum: Any, step: Any, unit: Any = None) -> dict[str, Any]:
    parameter: dict[str, Any] = {
        "type": "number",
        "min": _as_number(minimum, 0),
        "max": _as_number(maximum, 100),
        "step": _as_number(step, 1),
    }
    if unit:
        parameter["unit"] = str(unit)
    return parameter


def _enum_parameter(options: Any) -> dict[str, Any]:
    return {"type": "enum", "options": _string_list(options)}


def _add_options(parameters: dict[str, Any], name: str, options: Any) -> None:
    values = _string_list(options)
    if values:
        parameters[name] = {"type": "enum", "options": values}
