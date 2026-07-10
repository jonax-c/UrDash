from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ACTION_MANIFEST_PATH = Path(__file__).parent / "frontend" / "action-manifest.json"
ACTION_TYPES = ["service", "more_info", "navigate", "none"]
RISK_LEVELS = {"low", "medium", "high"}


def load_action_manifest(path: Path = ACTION_MANIFEST_PATH) -> dict[str, Any]:
    """Load and validate the canonical UrDash action manifest."""
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("version") != 1 or not isinstance(manifest.get("domains"), dict):
        raise ValueError("UrDash action manifest must use version 1 and define domains.")
    for domain, domain_policy in manifest["domains"].items():
        if not isinstance(domain, str) or not isinstance(domain_policy.get("services"), dict):
            raise ValueError(f"Invalid action manifest domain: {domain!r}")
        for service, policy in domain_policy["services"].items():
            if policy.get("risk") not in RISK_LEVELS:
                raise ValueError(f"Invalid risk for {domain}.{service}")
            for feature_key in ("supported_feature",):
                if feature_key in policy and not isinstance(policy[feature_key], int):
                    raise ValueError(f"Invalid feature flag for {domain}.{service}")
            for feature_key in ("supported_features_any", "supported_features_all"):
                flags = policy.get(feature_key, [])
                if not isinstance(flags, list) or any(not isinstance(flag, int) for flag in flags):
                    raise ValueError(f"Invalid feature flags for {domain}.{service}")
            parameters = policy.get("parameters", {})
            required = policy.get("required", [])
            required_any = policy.get("required_any", [])
            if (
                not isinstance(parameters, dict)
                or not isinstance(required, list)
                or not isinstance(required_any, list)
            ):
                raise ValueError(f"Invalid parameters for {domain}.{service}")
            if any(name not in parameters for name in required):
                raise ValueError(f"Unknown required parameter for {domain}.{service}")
            if any(
                not isinstance(group, list) or any(name not in parameters for name in group)
                for group in required_any
            ):
                raise ValueError(f"Unknown required-any parameter for {domain}.{service}")
    return manifest


def build_action_schema(manifest: dict[str, Any]) -> dict[str, Any]:
    """Build the AI response action schema from the canonical manifest."""
    domains = sorted(manifest["domains"])
    services: set[str] = set()
    parameters: dict[str, dict[str, Any]] = {}
    for domain_policy in manifest["domains"].values():
        for service, policy in domain_policy["services"].items():
            services.add(service)
            for name, parameter in policy.get("parameters", {}).items():
                schema = _parameter_schema(parameter)
                if name in parameters and parameters[name] != schema:
                    parameters[name] = _merge_parameter_schema(parameters[name], schema)
                else:
                    parameters[name] = schema

    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["type"],
        "properties": {
            "type": {"type": "string", "enum": ACTION_TYPES},
            "domain": {"type": "string", "enum": domains},
            "service": {"type": "string", "enum": sorted(services)},
            "entity_id": {"type": "string"},
            "navigation_path": {"type": "string"},
            "data": {
                "type": "object",
                "additionalProperties": False,
                "properties": parameters,
            },
            "confirmation": {
                "type": "object",
                "additionalProperties": False,
                "required": ["required", "text"],
                "properties": {
                    "required": {"type": "boolean"},
                    "text": {"type": "string"},
                },
            },
        },
    }


def get_service_policy(
    manifest: dict[str, Any], domain: str, service: str
) -> dict[str, Any] | None:
    """Return a service policy from a loaded manifest."""
    return manifest.get("domains", {}).get(domain, {}).get("services", {}).get(service)


def _parameter_schema(parameter: dict[str, Any]) -> dict[str, Any]:
    parameter_type = parameter.get("type")
    if parameter_type in {"number", "integer"}:
        numeric: dict[str, Any] = {"type": parameter_type}
        if "min" in parameter:
            numeric["minimum"] = parameter["min"]
        if "max" in parameter:
            numeric["maximum"] = parameter["max"]
        return {"anyOf": [numeric, {"type": "string"}]}
    if parameter_type == "boolean":
        return {"anyOf": [{"type": "boolean"}, {"type": "string"}]}
    if parameter_type == "rgb":
        return {
            "type": "array",
            "minItems": 3,
            "maxItems": 3,
            "items": {"type": "integer", "minimum": 0, "maximum": 255},
        }
    if parameter_type == "string_list":
        return {
            "type": "array",
            "maxItems": parameter.get("max_items", 16),
            "items": {"type": "string"},
        }
    schema: dict[str, Any] = {"type": "string"}
    if parameter_type == "enum" and parameter.get("options"):
        schema["enum"] = parameter["options"]
    return schema


def _merge_parameter_schema(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    if left == right:
        return left
    variants: list[dict[str, Any]] = []
    for schema in (left, right):
        for variant in schema.get("anyOf", [schema]):
            if variant not in variants:
                variants.append(variant)
    return {"anyOf": variants}


ACTION_MANIFEST = load_action_manifest()
ACTION_SCHEMA = build_action_schema(ACTION_MANIFEST)
