from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
import re
from typing import Any

from .action_policy import ACTION_MANIFEST, get_service_policy

MAX_DIAGNOSTICS = 64
MAX_BLOCKS = 64
MAX_ACTIONS = 96
MAX_VISUAL_NODES = 48
MAX_VISUAL_LINKS = 96
CURRENT_SCHEMA_MINOR = 0

BINDING_PATTERN = re.compile(r"^(state|last_changed|last_updated|attributes\.[A-Za-z0-9_]+)$")
ACTION_TEMPLATE_PATTERN = re.compile(
    r"^\$(selected|value|current)(?:\s*[+-]\s*\d+(?:\.\d+)?)?$"
)
NAVIGATION_PATTERN = re.compile(r"^/(?!/)[A-Za-z0-9_~!$&'()*+,;=:@%./?-]*$")
PATH_DATA_PATTERN = re.compile(r"^[MmZzLlHhVvCcSsQqTtAa0-9,.\-\s]+$")


def build_strict_provider_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Convert optional object properties to required nullable provider fields."""
    if "anyOf" in schema:
        result = {key: value for key, value in schema.items() if key != "anyOf"}
        result["anyOf"] = [build_strict_provider_schema(option) for option in schema["anyOf"]]
        return result
    result = dict(schema)
    if schema.get("type") == "object":
        original_required = set(schema.get("required", []))
        properties = {}
        for name, child in schema.get("properties", {}).items():
            transformed = build_strict_provider_schema(child)
            properties[name] = (
                transformed
                if name in original_required
                else {"anyOf": [transformed, {"type": "null"}]}
            )
        result["properties"] = properties
        result["required"] = list(properties)
        result["additionalProperties"] = False
    elif schema.get("type") == "array" and isinstance(schema.get("items"), dict):
        result["items"] = build_strict_provider_schema(schema["items"])
    return result


def strip_provider_nulls(value: Any) -> Any:
    """Remove strict-provider null placeholders from generated objects."""
    if isinstance(value, dict):
        return {
            key: strip_provider_nulls(child)
            for key, child in value.items()
            if child is not None
        }
    if isinstance(value, list):
        return [strip_provider_nulls(child) for child in value]
    return value


def migrate_card_config(config: dict[str, Any]) -> dict[str, Any]:
    """Normalize supported v2 cards to the current schema minor version."""
    migrated = deepcopy(config)
    if migrated.get("urdash_schema") == 2:
        migrated.setdefault("urdash_schema_minor", 0)
    return migrated


def validate_card_config(
    config: Any,
    schema: dict[str, Any],
    *,
    entities: list[dict[str, Any]] | None = None,
    available_services: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Validate an UrDash card structurally and semantically."""
    diagnostics: list[dict[str, Any]] = []
    _validate_schema(config, schema, "$", diagnostics)
    if any(item["severity"] == "error" for item in diagnostics):
        return diagnostics[:MAX_DIAGNOSTICS]
    _validate_semantics(
        config,
        {entity.get("entity_id"): entity for entity in entities or []},
        available_services,
        diagnostics,
    )
    return diagnostics[:MAX_DIAGNOSTICS]


def has_errors(diagnostics: list[dict[str, Any]]) -> bool:
    return any(item.get("severity") == "error" for item in diagnostics)


def format_diagnostics(diagnostics: list[dict[str, Any]], limit: int = 6) -> str:
    return "; ".join(
        f"{item['path']}: {item['message']}" for item in diagnostics[:limit]
    )


def _diagnostic(
    diagnostics: list[dict[str, Any]],
    path: str,
    code: str,
    message: str,
    suggestion: str,
    severity: str = "error",
) -> None:
    if len(diagnostics) >= MAX_DIAGNOSTICS:
        return
    diagnostics.append(
        {
            "path": path,
            "code": code,
            "message": message,
            "suggestion": suggestion,
            "severity": severity,
        }
    )


def _validate_schema(
    value: Any,
    schema: Mapping[str, Any],
    path: str,
    diagnostics: list[dict[str, Any]],
) -> None:
    if len(diagnostics) >= MAX_DIAGNOSTICS:
        return
    if "anyOf" in schema:
        variants = []
        for option in schema["anyOf"]:
            option_diagnostics: list[dict[str, Any]] = []
            _validate_schema(value, option, path, option_diagnostics)
            if not option_diagnostics:
                return
            variants.append(option_diagnostics)
        _diagnostic(
            diagnostics,
            path,
            "schema.any_of",
            "Value does not match any allowed schema variant.",
            "Use one of the documented value types.",
        )
        return

    expected = schema.get("type")
    if expected and not _matches_type(value, expected):
        _diagnostic(
            diagnostics,
            path,
            "schema.type",
            f"Expected {expected}, got {type(value).__name__}.",
            f"Replace this value with a valid {expected} value.",
        )
        return
    if "enum" in schema and value not in schema["enum"]:
        _diagnostic(
            diagnostics,
            path,
            "schema.enum",
            f"Value {value!r} is not allowed.",
            f"Use one of: {', '.join(map(str, schema['enum'][:12]))}.",
        )
        return

    if expected == "object":
        properties = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in value:
                _diagnostic(
                    diagnostics,
                    f"{path}.{name}",
                    "schema.required",
                    f"Required key {name!r} is missing.",
                    f"Add the {name!r} property.",
                )
        if schema.get("additionalProperties") is False:
            for name in value:
                if name not in properties:
                    _diagnostic(
                        diagnostics,
                        f"{path}.{name}",
                        "schema.additional_property",
                        f"Unknown key {name!r} is not allowed.",
                        "Remove the unknown property.",
                    )
        for name, child in value.items():
            if name in properties:
                _validate_schema(child, properties[name], f"{path}.{name}", diagnostics)
    elif expected == "array":
        if len(value) < schema.get("minItems", 0):
            _diagnostic(
                diagnostics,
                path,
                "schema.min_items",
                "Array has too few items.",
                f"Provide at least {schema['minItems']} items.",
            )
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            _diagnostic(
                diagnostics,
                path,
                "schema.max_items",
                "Array exceeds its item limit.",
                f"Keep at most {schema['maxItems']} items.",
            )
        for index, child in enumerate(value):
            _validate_schema(child, schema.get("items", {}), f"{path}[{index}]", diagnostics)
    elif expected in {"number", "integer"}:
        if "minimum" in schema and value < schema["minimum"]:
            _diagnostic(
                diagnostics,
                path,
                "schema.minimum",
                f"Value is below {schema['minimum']}.",
                f"Use a value of at least {schema['minimum']}.",
            )
        if "maximum" in schema and value > schema["maximum"]:
            _diagnostic(
                diagnostics,
                path,
                "schema.maximum",
                f"Value exceeds {schema['maximum']}.",
                f"Use a value no greater than {schema['maximum']}.",
            )


def _matches_type(value: Any, expected: str | list[str]) -> bool:
    if isinstance(expected, list):
        return any(_matches_type(value, item) for item in expected)
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, int | float) and not isinstance(value, bool)
    return True


def _validate_semantics(
    config: dict[str, Any],
    entities: dict[str, dict[str, Any]],
    available_services: set[str] | None,
    diagnostics: list[dict[str, Any]],
) -> None:
    card = config["card"]
    layout = card["layout"]
    blocks = layout["blocks"]
    if len(blocks) > MAX_BLOCKS:
        _diagnostic(
            diagnostics,
            "$.card.layout.blocks",
            "budget.blocks",
            f"Card has {len(blocks)} blocks; the limit is {MAX_BLOCKS}.",
            "Reduce or combine blocks.",
        )

    for index, entity_id in enumerate(card["intent"].get("primary_entities", [])):
        _validate_entity(entity_id, f"$.card.intent.primary_entities[{index}]", entities, diagnostics)

    seen_ids: dict[str, str] = {}
    action_count = 0
    columns = layout.get("columns", 12)
    for index, block in enumerate(blocks):
        path = f"$.card.layout.blocks[{index}]"
        _validate_unique_id(block.get("id"), f"{path}.id", seen_ids, diagnostics)
        _validate_block_references(block, path, entities, diagnostics)
        _validate_bindings(block, path, diagnostics)
        grid = block.get("grid")
        if layout["type"] == "grid" and grid:
            if grid["col"] + grid["w"] - 1 > columns:
                _diagnostic(
                    diagnostics,
                    f"{path}.grid",
                    "layout.grid_overflow",
                    "Block extends beyond the configured grid columns.",
                    "Reduce col or width so the block fits the grid.",
                )
        actions = _block_actions(block, path)
        action_count += len(actions)
        for action, action_path in actions:
            _validate_action(action, action_path, entities, available_services, diagnostics)
        if block.get("kind") == "visual_map":
            _validate_visual_map(block, path, seen_ids, entities, diagnostics)
        _validate_vector_budget(block, path, diagnostics)
    if action_count > MAX_ACTIONS:
        _diagnostic(
            diagnostics,
            "$.card.layout.blocks",
            "budget.actions",
            f"Card declares {action_count} actions; the limit is {MAX_ACTIONS}.",
            "Reduce repeated controls.",
        )


def _validate_unique_id(
    value: Any,
    path: str,
    seen: dict[str, str],
    diagnostics: list[dict[str, Any]],
) -> None:
    if not isinstance(value, str):
        return
    if value in seen:
        _diagnostic(
            diagnostics,
            path,
            "semantic.duplicate_id",
            f"ID {value!r} is already used at {seen[value]}.",
            "Choose a unique stable ID.",
        )
    else:
        seen[value] = path


def _validate_entity(
    entity_id: Any,
    path: str,
    entities: dict[str, dict[str, Any]],
    diagnostics: list[dict[str, Any]],
) -> None:
    if not isinstance(entity_id, str) or not entities:
        return
    if entity_id not in entities:
        _diagnostic(
            diagnostics,
            path,
            "semantic.missing_entity",
            f"Entity {entity_id!r} is not present in Home Assistant.",
            "Use an entity ID from the selected entity capability context.",
        )


def _validate_block_references(
    block: dict[str, Any],
    path: str,
    entities: dict[str, dict[str, Any]],
    diagnostics: list[dict[str, Any]],
) -> None:
    if block.get("entity"):
        _validate_entity(block["entity"], f"{path}.entity", entities, diagnostics)
    for key in ("entities",):
        for index, entity_id in enumerate(block.get(key, [])):
            _validate_entity(entity_id, f"{path}.{key}[{index}]", entities, diagnostics)
    for key in ("items", "chips", "actions"):
        for index, item in enumerate(block.get(key, [])):
            entity_id = item.get("entity") or item.get("entity_id")
            if entity_id:
                _validate_entity(entity_id, f"{path}.{key}[{index}]", entities, diagnostics)
    visibility = block.get("visibility")
    if visibility:
        _validate_entity(visibility.get("entity"), f"{path}.visibility.entity", entities, diagnostics)


def _validate_bindings(value: Any, path: str, diagnostics: list[dict[str, Any]]) -> None:
    if isinstance(value, dict):
        if "bind" in value and isinstance(value["bind"], dict):
            for name, binding in value["bind"].items():
                if isinstance(binding, str) and not BINDING_PATTERN.fullmatch(binding):
                    _diagnostic(
                        diagnostics,
                        f"{path}.bind.{name}",
                        "semantic.invalid_binding",
                        f"Binding {binding!r} is not allowed.",
                        "Use state, last_changed, last_updated, or attributes.<name>.",
                    )
        for name, child in value.items():
            if name != "bind":
                _validate_bindings(child, f"{path}.{name}", diagnostics)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _validate_bindings(child, f"{path}[{index}]", diagnostics)


def _block_actions(block: dict[str, Any], path: str) -> list[tuple[dict[str, Any], str]]:
    actions: list[tuple[dict[str, Any], str]] = []
    if isinstance(block.get("action"), dict):
        actions.append((block["action"], f"{path}.action"))
    for index, button in enumerate(block.get("buttons", [])):
        if isinstance(button.get("action"), dict):
            actions.append((button["action"], f"{path}.buttons[{index}].action"))
    for index, node in enumerate(block.get("nodes", [])):
        if isinstance(node.get("action"), dict):
            actions.append((node["action"], f"{path}.nodes[{index}].action"))
    return actions


def _validate_action(
    action: dict[str, Any],
    path: str,
    entities: dict[str, dict[str, Any]],
    available_services: set[str] | None,
    diagnostics: list[dict[str, Any]],
) -> None:
    action_type = action.get("type")
    if action_type == "navigate":
        navigation_path = str(action.get("navigation_path") or "")
        if not NAVIGATION_PATTERN.fullmatch(navigation_path) or "\\" in navigation_path:
            _diagnostic(
                diagnostics,
                f"{path}.navigation_path",
                "action.invalid_navigation",
                "Navigation must be a safe internal Home Assistant path.",
                "Use a path beginning with one slash, such as /lovelace/home.",
            )
        return
    if action_type not in {"service", "more_info"}:
        return
    entity_id = action.get("entity_id")
    _validate_entity(entity_id, f"{path}.entity_id", entities, diagnostics)
    if action_type != "service" or not isinstance(entity_id, str):
        return
    domain = action.get("domain")
    service = action.get("service")
    if entity_id.partition(".")[0] != domain:
        _diagnostic(
            diagnostics,
            f"{path}.domain",
            "action.domain_mismatch",
            "Action domain does not match the target entity domain.",
            "Use the entity's domain for this action.",
        )
    policy = get_service_policy(ACTION_MANIFEST, str(domain), str(service))
    if policy is None:
        _diagnostic(
            diagnostics,
            f"{path}.service",
            "action.denied_service",
            f"Service {domain}.{service} is not allowed by UrDash.",
            "Use a capability listed for the selected entity.",
        )
        return
    service_id = f"{domain}.{service}"
    if available_services is not None and service_id not in available_services:
        _diagnostic(
            diagnostics,
            f"{path}.service",
            "action.unavailable_service",
            f"Service {service_id} is not registered in Home Assistant.",
            "Remove the action or choose a currently available service.",
        )
    entity = entities.get(entity_id)
    if entity and not _entity_supports_policy(entity, policy):
        _diagnostic(
            diagnostics,
            path,
            "action.unsupported_capability",
            f"Entity {entity_id} does not support {service_id}.",
            "Use one of the entity's advertised capabilities.",
        )
    _validate_action_data(action.get("data", {}), policy, f"{path}.data", diagnostics)


def _entity_supports_policy(entity: dict[str, Any], policy: dict[str, Any]) -> bool:
    attributes = entity.get("attributes") or {}
    features = int(attributes.get("supported_features") or 0)
    if policy.get("required_attribute") and attributes.get(policy["required_attribute"]) is None:
        return False
    if features == 0 and policy.get("allow_zero_features") is True:
        return True
    if policy.get("supported_feature") is not None and not features & int(policy["supported_feature"]):
        return False
    if policy.get("supported_features_any") and not any(
        features & int(flag) for flag in policy["supported_features_any"]
    ):
        return False
    return not policy.get("supported_features_all") or all(
        features & int(flag) for flag in policy["supported_features_all"]
    )


def _validate_action_data(
    data: Any,
    policy: dict[str, Any],
    path: str,
    diagnostics: list[dict[str, Any]],
) -> None:
    if not isinstance(data, dict):
        return
    parameters = policy.get("parameters", {})
    for name in policy.get("required", []):
        if name not in data:
            _diagnostic(
                diagnostics,
                f"{path}.{name}",
                "action.missing_parameter",
                f"Required action parameter {name!r} is missing.",
                f"Add a valid {name!r} value.",
            )
    for group in policy.get("required_any", []):
        if not any(name in data for name in group):
            _diagnostic(
                diagnostics,
                path,
                "action.missing_parameter_group",
                "Action is missing a required parameter choice.",
                f"Provide one of: {', '.join(group)}.",
            )
    for name, value in data.items():
        parameter = parameters.get(name)
        if parameter is None:
            _diagnostic(
                diagnostics,
                f"{path}.{name}",
                "action.unknown_parameter",
                f"Parameter {name!r} is not allowed for this service.",
                "Remove the unsupported parameter.",
            )
        elif not _parameter_allowed(parameter, value):
            _diagnostic(
                diagnostics,
                f"{path}.{name}",
                "action.invalid_parameter",
                f"Value for {name!r} violates the action policy.",
                "Use the entity capability type, options, and numeric range.",
            )


def _parameter_allowed(parameter: dict[str, Any], value: Any) -> bool:
    if isinstance(value, str) and ACTION_TEMPLATE_PATTERN.fullmatch(value):
        return True
    parameter_type = parameter.get("type")
    if parameter_type in {"number", "integer"}:
        if not isinstance(value, int | float) or isinstance(value, bool):
            return False
        if parameter_type == "integer" and not isinstance(value, int):
            return False
        return not (
            (parameter.get("min") is not None and value < parameter["min"])
            or (parameter.get("max") is not None and value > parameter["max"])
        )
    if parameter_type == "boolean":
        return isinstance(value, bool)
    if parameter_type == "rgb":
        return (
            isinstance(value, list)
            and len(value) == 3
            and all(isinstance(part, int) and 0 <= part <= 255 for part in value)
        )
    if parameter_type == "string_list":
        return (
            isinstance(value, list)
            and len(value) <= parameter.get("max_items", 16)
            and all(isinstance(item, str) for item in value)
        )
    if not isinstance(value, str) or len(value) > parameter.get("max_length", 256):
        return False
    return parameter_type != "enum" or value in parameter.get("options", [])


def _validate_visual_map(
    block: dict[str, Any],
    path: str,
    seen_ids: dict[str, str],
    entities: dict[str, dict[str, Any]],
    diagnostics: list[dict[str, Any]],
) -> None:
    nodes = block.get("nodes", [])
    links = block.get("links", [])
    if len(nodes) > MAX_VISUAL_NODES:
        _diagnostic(
            diagnostics,
            f"{path}.nodes",
            "budget.nodes",
            "Visual map has too many nodes.",
            f"Keep at most {MAX_VISUAL_NODES} nodes.",
        )
    if len(links) > MAX_VISUAL_LINKS:
        _diagnostic(
            diagnostics,
            f"{path}.links",
            "budget.links",
            "Visual map has too many links.",
            f"Keep at most {MAX_VISUAL_LINKS} links.",
        )
    node_ids = set()
    for index, node in enumerate(nodes):
        node_path = f"{path}.nodes[{index}]"
        node_id = node.get("id")
        _validate_unique_id(node_id, f"{node_path}.id", seen_ids, diagnostics)
        if isinstance(node_id, str):
            node_ids.add(node_id)
        if node.get("entity"):
            _validate_entity(node["entity"], f"{node_path}.entity", entities, diagnostics)
    for index, link in enumerate(links):
        link_path = f"{path}.links[{index}]"
        if link.get("entity"):
            _validate_entity(link["entity"], f"{link_path}.entity", entities, diagnostics)
        for endpoint in ("from", "to"):
            if link.get(endpoint) not in node_ids:
                _diagnostic(
                    diagnostics,
                    f"{link_path}.{endpoint}",
                    "semantic.missing_node",
                    f"Link references unknown node {link.get(endpoint)!r}.",
                    "Use an ID declared in this visual map's nodes.",
                )


def _validate_vector_budget(
    block: dict[str, Any], path: str, diagnostics: list[dict[str, Any]]
) -> None:
    if block.get("kind") != "vector_icon":
        return
    art = (
        block.get("render_budget") == "art"
        or block.get("performance_budget") == "art"
    )
    limits = {
        "shapes": 120 if art else 48,
        "gradients": 24 if art else 8,
        "depth": 3 if art else 2,
    }
    if len(block.get("gradients", [])) > limits["gradients"]:
        _diagnostic(
            diagnostics,
            f"{path}.gradients",
            "budget.gradients",
            "Vector icon exceeds its gradient budget.",
            f"Keep at most {limits['gradients']} gradients.",
        )
    if len(block.get("shapes", [])) > limits["shapes"]:
        _diagnostic(
            diagnostics,
            f"{path}.shapes",
            "budget.shapes",
            "Vector icon exceeds its shape budget.",
            f"Keep at most {limits['shapes']} top-level shapes.",
        )
    for index, shape in enumerate(block.get("shapes", [])):
        _validate_shape_depth(
            shape,
            f"{path}.shapes[{index}]",
            0,
            limits["depth"],
            2400 if art else 600,
            diagnostics,
        )


def _validate_shape_depth(
    shape: dict[str, Any],
    path: str,
    depth: int,
    limit: int,
    path_limit: int,
    diagnostics: list[dict[str, Any]],
) -> None:
    if depth > limit:
        _diagnostic(
            diagnostics,
            path,
            "budget.shape_depth",
            "Vector group nesting is too deep.",
            f"Keep nesting at or below {limit} levels.",
        )
        return
    path_data = shape.get("d")
    if isinstance(path_data, str) and (
        len(path_data) > path_limit or not PATH_DATA_PATTERN.fullmatch(path_data)
    ):
        _diagnostic(
            diagnostics,
            f"{path}.d",
            "semantic.invalid_path_data",
            "Vector path contains unsupported data or exceeds its budget.",
            "Use only declarative SVG path commands and numeric coordinates.",
        )
    for index, child in enumerate(shape.get("shapes", [])):
        _validate_shape_depth(
            child,
            f"{path}.shapes[{index}]",
            depth + 1,
            limit,
            path_limit,
            diagnostics,
        )
