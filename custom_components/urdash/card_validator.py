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
MAX_EXPRESSION_DEPTH = 8
MAX_EXPRESSION_OPERATIONS = 128
MAX_EXPRESSION_ARGS = 16
MAX_EXPRESSION_ENTITIES = 32
MAX_EXPRESSION_OUTPUT = 1024
MAX_DATA_SOURCES = 4
MAX_ICON_SETS = 8
MAX_ICON_VARIANTS = 96
MAX_COMPONENT_NODES = 96
MAX_COMPONENT_DEPTH = 6
CURRENT_SCHEMA_MINOR = 0

BINDING_PATTERN = re.compile(
    r"^(state|last_changed|last_updated|attributes(?:\.[A-Za-z_][A-Za-z0-9_]*)+)$"
)
SAFE_PATH_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$")
SOURCE_ID_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
MDI_ICON_PATTERN = re.compile(r"^mdi:[a-z0-9][a-z0-9-]{0,95}$")
UNSAFE_PATH_PARTS = {"__proto__", "prototype", "constructor"}
EXPRESSION_OPS = {
    "literal", "entity", "local", "add", "subtract", "multiply", "divide",
    "modulo", "min", "max", "average", "sum", "clamp", "round", "percentage",
    "eq", "ne", "gt", "gte", "lt", "lte", "and", "or", "not", "if",
    "coalesce", "map", "format_number", "format_datetime", "format_duration",
    "relative_time", "convert_unit", "concat", "source",
}
WEATHER_FEATURES = {"daily": 1, "hourly": 2, "twice_daily": 4}
FORECAST_FIELDS = {
    "datetime", "is_daytime", "condition", "temperature", "templow",
    "apparent_temperature", "dew_point", "precipitation",
    "precipitation_probability", "humidity", "pressure", "cloud_coverage",
    "uv_index", "wind_bearing", "wind_speed", "wind_gust_speed",
}
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
    if isinstance(schema.get("$defs"), dict):
        result["$defs"] = {
            name: build_strict_provider_schema(child)
            for name, child in schema["$defs"].items()
        }
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
    _validate_schema(config, schema, "$", diagnostics, schema)
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
    root_schema: Mapping[str, Any] | None = None,
) -> None:
    if len(diagnostics) >= MAX_DIAGNOSTICS:
        return
    root_schema = root_schema or schema
    if "$ref" in schema:
        resolved = _resolve_local_ref(root_schema, schema["$ref"])
        if resolved is None:
            _diagnostic(diagnostics, path, "schema.invalid_ref", "Schema reference could not be resolved.", "Use a declared local schema reference.")
            return
        _validate_schema(value, resolved, path, diagnostics, root_schema)
        return
    if "anyOf" in schema:
        variants = []
        for option in schema["anyOf"]:
            option_diagnostics: list[dict[str, Any]] = []
            _validate_schema(value, option, path, option_diagnostics, root_schema)
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
                _validate_schema(child, properties[name], f"{path}.{name}", diagnostics, root_schema)
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
            _validate_schema(child, schema.get("items", {}), f"{path}[{index}]", diagnostics, root_schema)
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
    if expected == "null":
        return value is None
    return True


def _resolve_local_ref(root_schema: Mapping[str, Any], ref: Any) -> Mapping[str, Any] | None:
    if not isinstance(ref, str) or not ref.startswith("#/"):
        return None
    current: Any = root_schema
    for part in ref[2:].split("/"):
        if not isinstance(current, Mapping) or part not in current:
            return None
        current = current[part]
    return current if isinstance(current, Mapping) else None


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
    icon_sets = _validate_assets(card.get("assets", {}), diagnostics)
    data_sources = _validate_data_sources(card.get("data_sources", []), entities, diagnostics)
    _validate_expressions(config, "$", entities, data_sources, diagnostics)
    _validate_icon_references(config, "$", icon_sets, diagnostics)

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
        if block.get("kind") == "component_tree":
            _validate_component_tree(block.get("component"), f"{path}.component", entities, diagnostics)
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


def _validate_data_sources(
    sources: list[dict[str, Any]],
    entities: dict[str, dict[str, Any]],
    diagnostics: list[dict[str, Any]],
) -> set[str]:
    source_ids: set[str] = set()
    if len(sources) > MAX_DATA_SOURCES:
        _diagnostic(diagnostics, "$.card.data_sources", "budget.data_sources", f"Card has more than {MAX_DATA_SOURCES} data sources.", "Reduce the number of subscribed sources.")
    for index, source in enumerate(sources):
        path = f"$.card.data_sources[{index}]"
        source_id = source.get("id")
        if isinstance(source_id, str):
            if not SOURCE_ID_PATTERN.fullmatch(source_id):
                _diagnostic(diagnostics, f"{path}.id", "data_source.invalid_id", "Data source ID is malformed.", "Use 1-64 letters, numbers, underscores, or hyphens, starting with a letter.")
            if source_id in source_ids:
                _diagnostic(diagnostics, f"{path}.id", "semantic.duplicate_source", f"Data source ID {source_id!r} is duplicated.", "Use a unique data source ID.")
            source_ids.add(source_id)
        entity_id = source.get("entity")
        _validate_entity(entity_id, f"{path}.entity", entities, diagnostics)
        if isinstance(entity_id, str) and entity_id.partition(".")[0] != "weather":
            _diagnostic(diagnostics, f"{path}.entity", "data_source.invalid_domain", "Weather forecast sources require a weather entity.", "Select an entity whose ID starts with weather.")
            continue
        entity = entities.get(entity_id) if isinstance(entity_id, str) else None
        if entity and entity.get("domain", str(entity_id).partition(".")[0]) != "weather":
            _diagnostic(diagnostics, f"{path}.entity", "data_source.invalid_domain", "Weather forecast sources require a weather entity.", "Select an entity whose ID starts with weather.")
            continue
        forecast_type = source.get("forecast_type")
        if entity and isinstance(forecast_type, str):
            features = int((entity.get("attributes") or {}).get("supported_features") or 0)
            required_feature = WEATHER_FEATURES.get(forecast_type, 0)
            if required_feature and not features & required_feature:
                _diagnostic(diagnostics, f"{path}.forecast_type", "data_source.unsupported_forecast", f"Entity {entity_id} does not advertise {forecast_type} forecasts.", "Use one of the entity's supported forecast types.")
    return source_ids


def _validate_assets(
    assets: dict[str, Any], diagnostics: list[dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    icon_sets: dict[str, dict[str, Any]] = {}
    sets = assets.get("icon_sets", []) if isinstance(assets, dict) else []
    total_variants = 0
    if len(sets) > MAX_ICON_SETS:
        _diagnostic(diagnostics, "$.card.assets.icon_sets", "budget.icon_sets", f"Card has more than {MAX_ICON_SETS} icon sets.", "Reduce reusable icon sets.")
    for set_index, icon_set in enumerate(sets):
        path = f"$.card.assets.icon_sets[{set_index}]"
        set_id = icon_set.get("id")
        if isinstance(set_id, str):
            if not SOURCE_ID_PATTERN.fullmatch(set_id):
                _diagnostic(diagnostics, f"{path}.id", "asset.invalid_id", "Icon set ID is malformed.", "Use 1-64 letters, numbers, underscores, or hyphens, starting with a letter.")
            if set_id in icon_sets:
                _diagnostic(diagnostics, f"{path}.id", "asset.duplicate_set", f"Icon set {set_id!r} is duplicated.", "Use a unique icon set ID.")
        keys: set[str] = set()
        variants = icon_set.get("variants", [])
        total_variants += len(variants)
        for variant_index, variant in enumerate(variants):
            variant_path = f"{path}.variants[{variant_index}]"
            key = variant.get("key")
            if isinstance(key, str):
                if not SOURCE_ID_PATTERN.fullmatch(key):
                    _diagnostic(diagnostics, f"{variant_path}.key", "asset.invalid_key", "Icon variant key is malformed.", "Use a safe stable variant key.")
                if key in keys:
                    _diagnostic(diagnostics, f"{variant_path}.key", "asset.duplicate_variant", f"Variant {key!r} is duplicated.", "Use a unique key within the icon set.")
                keys.add(key)
            _validate_icon_asset(variant, variant_path, diagnostics)
        fallback = icon_set.get("fallback")
        if isinstance(fallback, dict):
            _validate_icon_asset(fallback, f"{path}.fallback", diagnostics)
        if isinstance(set_id, str):
            icon_sets[set_id] = {"keys": keys, "fallback": isinstance(fallback, dict)}
    if total_variants > MAX_ICON_VARIANTS:
        _diagnostic(diagnostics, "$.card.assets.icon_sets", "budget.icon_variants", f"Card declares more than {MAX_ICON_VARIANTS} icon variants.", "Reduce or combine reusable variants.")
    return icon_sets


def _validate_icon_asset(
    asset: dict[str, Any], path: str, diagnostics: list[dict[str, Any]]
) -> None:
    has_icon = isinstance(asset.get("icon"), str) and bool(asset.get("icon"))
    has_vector = isinstance(asset.get("vector_icon"), dict)
    if has_icon == has_vector:
        _diagnostic(diagnostics, path, "asset.invalid_variant", "An icon asset must define exactly one icon or vector_icon.", "Keep one MDI icon or one declarative vector icon.")
    if has_icon and not MDI_ICON_PATTERN.fullmatch(asset["icon"]):
        _diagnostic(diagnostics, f"{path}.icon", "asset.invalid_icon", "Reusable icon names must use the mdi: namespace.", "Use an icon such as mdi:weather-sunny.")
    if has_vector:
        _validate_vector_icon_budget(asset["vector_icon"], f"{path}.vector_icon", diagnostics)


def _validate_icon_references(
    value: Any,
    path: str,
    icon_sets: dict[str, dict[str, Any]],
    diagnostics: list[dict[str, Any]],
) -> None:
    if isinstance(value, dict):
        reference = value.get("icon_ref")
        if isinstance(reference, dict):
            set_id = reference.get("set")
            icon_set = icon_sets.get(set_id)
            if icon_set is None:
                _diagnostic(diagnostics, f"{path}.icon_ref.set", "asset.missing_set", f"Icon set {set_id!r} is not declared.", "Reference an ID from card.assets.icon_sets.")
            key = reference.get("key")
            if isinstance(key, str) and icon_set and key not in icon_set["keys"] and not icon_set["fallback"]:
                _diagnostic(diagnostics, f"{path}.icon_ref.key", "asset.missing_variant", f"Variant {key!r} is not present and the set has no fallback.", "Add the variant or a fallback icon.")
        for name, child in value.items():
            if name != "icon_ref":
                _validate_icon_references(child, f"{path}.{name}", icon_sets, diagnostics)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _validate_icon_references(child, f"{path}[{index}]", icon_sets, diagnostics)


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
        if "expression" not in visibility and not (
            isinstance(visibility.get("entity"), str)
            and isinstance(visibility.get("operator"), str)
        ):
            _diagnostic(
                diagnostics,
                f"{path}.visibility",
                "semantic.invalid_visibility",
                "Visibility requires an expression or an entity and operator.",
                "Add a boolean expression or a legacy entity visibility rule.",
            )
    _validate_component_entities(block.get("component"), f"{path}.component", entities, diagnostics)


def _validate_component_entities(
    node: Any,
    path: str,
    entities: dict[str, dict[str, Any]],
    diagnostics: list[dict[str, Any]],
) -> None:
    if not isinstance(node, dict):
        return
    if node.get("entity"):
        _validate_entity(node["entity"], f"{path}.entity", entities, diagnostics)
    for index, child in enumerate(node.get("children", [])):
        _validate_component_entities(child, f"{path}.children[{index}]", entities, diagnostics)


def _validate_component_tree(
    root: Any,
    path: str,
    entities: dict[str, dict[str, Any]],
    diagnostics: list[dict[str, Any]],
) -> None:
    if not isinstance(root, dict):
        _diagnostic(diagnostics, path, "component.missing_root", "Component-tree blocks require a root component.", "Add a safe component object.")
        return
    container_types = {"row", "column", "stack", "wrap", "surface"}
    leaf_types = {
        "text", "icon", "value", "toggle", "slider", "color_picker", "select",
        "button", "progress", "divider", "spacer",
    }
    state = {"nodes": 0, "ids": set()}

    def visit(node: Any, node_path: str, depth: int) -> None:
        if not isinstance(node, dict):
            return
        state["nodes"] += 1
        if state["nodes"] > MAX_COMPONENT_NODES:
            _diagnostic(diagnostics, node_path, "budget.component_nodes", f"Component tree exceeds {MAX_COMPONENT_NODES} nodes.", "Reduce or reuse component structure.")
            return
        if depth > MAX_COMPONENT_DEPTH:
            _diagnostic(diagnostics, node_path, "budget.component_depth", f"Component tree exceeds {MAX_COMPONENT_DEPTH} levels.", "Flatten nested containers.")
            return
        node_type = node.get("type")
        children = node.get("children", [])
        if node_type in container_types and not children:
            _diagnostic(diagnostics, f"{node_path}.children", "component.empty_container", f"Container {node_type!r} has no children.", "Add at least one child component.", severity="warning")
        if node_type in leaf_types and children:
            _diagnostic(diagnostics, f"{node_path}.children", "component.leaf_children", f"Leaf component {node_type!r} cannot contain children.", "Move children into a row, column, stack, wrap, or surface.")
        node_id = node.get("id")
        if isinstance(node_id, str):
            if not SOURCE_ID_PATTERN.fullmatch(node_id):
                _diagnostic(diagnostics, f"{node_path}.id", "component.invalid_id", "Component ID is malformed.", "Use a safe stable identifier.")
            if node_id in state["ids"]:
                _diagnostic(diagnostics, f"{node_path}.id", "component.duplicate_id", f"Component ID {node_id!r} is duplicated.", "Use a unique component ID within the tree.")
            state["ids"].add(node_id)
        if node_type in {"slider", "color_picker", "select"} and not isinstance(node.get("action"), dict):
            _diagnostic(
                diagnostics,
                f"{node_path}.action",
                "component.missing_action",
                f"{node_type.replace('_', ' ').title()} components require an explicit safe action.",
                "Add an allowlisted service action using the local value.",
            )
        range_config = node.get("range")
        if isinstance(range_config, dict):
            minimum = range_config.get("min")
            maximum = range_config.get("max")
            step = range_config.get("step")
            if isinstance(minimum, int | float) and isinstance(maximum, int | float) and minimum >= maximum:
                _diagnostic(diagnostics, f"{node_path}.range", "component.invalid_range", "Range minimum must be less than maximum.", "Correct the range bounds.")
            if isinstance(step, int | float) and step <= 0:
                _diagnostic(diagnostics, f"{node_path}.range.step", "component.invalid_step", "Range step must be positive.", "Use a positive step value.")
        for index, child in enumerate(children):
            visit(child, f"{node_path}.children[{index}]", depth + 1)

    visit(root, path, 1)


def _validate_bindings(value: Any, path: str, diagnostics: list[dict[str, Any]]) -> None:
    if isinstance(value, dict):
        if "bind" in value and isinstance(value["bind"], dict):
            for name, binding in value["bind"].items():
                if isinstance(binding, str) and not _safe_binding(binding):
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


def _safe_binding(binding: str) -> bool:
    return bool(BINDING_PATTERN.fullmatch(binding)) and not any(
        part in UNSAFE_PATH_PARTS for part in binding.split(".")
    )


def _validate_expressions(
    value: Any,
    path: str,
    entities: dict[str, dict[str, Any]],
    data_sources: set[str],
    diagnostics: list[dict[str, Any]],
) -> None:
    budget = {"operations": 0, "entities": set()}

    def visit(node: Any, node_path: str, depth: int) -> None:
        if isinstance(node, list):
            for index, child in enumerate(node):
                visit(child, f"{node_path}[{index}]", depth)
            return
        if not isinstance(node, dict):
            return
        if isinstance(node.get("op"), str):
            budget["operations"] += 1
            if budget["operations"] > MAX_EXPRESSION_OPERATIONS:
                _diagnostic(diagnostics, node_path, "expression.operation_budget", f"Expression exceeds {MAX_EXPRESSION_OPERATIONS} operations.", "Simplify or split the derived value.")
                return
            if depth > MAX_EXPRESSION_DEPTH:
                _diagnostic(diagnostics, node_path, "expression.depth_budget", f"Expression nesting exceeds {MAX_EXPRESSION_DEPTH} levels.", "Flatten the expression tree.")
                return
            op = node["op"]
            if op not in EXPRESSION_OPS:
                _diagnostic(diagnostics, f"{node_path}.op", "expression.invalid_op", f"Expression operation {op!r} is not allowed.", "Use a documented declarative operation.")
                return
            args = node.get("args", [])
            if isinstance(args, list) and len(args) > MAX_EXPRESSION_ARGS:
                _diagnostic(diagnostics, f"{node_path}.args", "expression.argument_budget", f"Expression has more than {MAX_EXPRESSION_ARGS} arguments.", "Reduce the aggregation inputs.")
            required = {
                "literal": "value", "entity": "entity_id", "local": "name", "source": "source_id",
                "if": "condition", "map": "cases", "convert_unit": "to_unit",
            }.get(op)
            if required and required not in node:
                _diagnostic(diagnostics, f"{node_path}.{required}", "expression.missing_field", f"Operation {op!r} requires {required!r}.", f"Add the {required!r} property.")
            if op == "entity":
                entity_id = node.get("entity_id")
                if isinstance(entity_id, str):
                    budget["entities"].add(entity_id)
                    _validate_entity(entity_id, f"{node_path}.entity_id", entities, diagnostics)
                path_value = node.get("path", "state")
                if not isinstance(path_value, str) or not _safe_expression_path(path_value):
                    _diagnostic(diagnostics, f"{node_path}.path", "expression.invalid_path", "Entity path is unsafe or malformed.", "Use state, last_changed, last_updated, or attributes.<nested.path>.")
            if op == "source":
                source_id = node.get("source_id")
                if source_id not in data_sources:
                    _diagnostic(diagnostics, f"{node_path}.source_id", "expression.missing_source", f"Data source {source_id!r} is not declared.", "Reference an ID from card.data_sources.")
                source_path = node.get("path")
                if not isinstance(source_path, str) or not _safe_forecast_path(source_path):
                    _diagnostic(diagnostics, f"{node_path}.path", "expression.invalid_source_path", "Forecast source path is unsafe or unsupported.", "Use type or forecast.<0-15>.<documented field>.")
            for name, child in node.items():
                if name not in {"op", "entity_id", "source_id", "path", "name", "value", "from_unit", "to_unit", "style", "decimals", "min", "max", "prefix", "suffix"}:
                    visit(child, f"{node_path}.{name}", depth + 1)
            if op == "literal" and isinstance(node.get("value"), str) and len(node["value"]) > MAX_EXPRESSION_OUTPUT:
                _diagnostic(diagnostics, f"{node_path}.value", "expression.output_budget", f"Literal exceeds {MAX_EXPRESSION_OUTPUT} characters.", "Use a shorter display value.")
            return
        for name, child in node.items():
            visit(child, f"{node_path}.{name}", depth)

    visit(value, path, 1)
    if len(budget["entities"]) > MAX_EXPRESSION_ENTITIES:
        _diagnostic(diagnostics, path, "expression.entity_budget", f"Expressions reference more than {MAX_EXPRESSION_ENTITIES} entities.", "Reduce multi-entity inputs.")


def _safe_expression_path(path: str) -> bool:
    if path in {"state", "last_changed", "last_updated"}:
        return True
    return bool(path.startswith("attributes.") and SAFE_PATH_PATTERN.fullmatch(path)) and not any(
        part in UNSAFE_PATH_PARTS for part in path.split(".")
    )


def _safe_forecast_path(path: str) -> bool:
    if path in {"type", "status"}:
        return True
    parts = path.split(".")
    return (
        len(parts) == 3
        and parts[0] == "forecast"
        and parts[1].isdigit()
        and 0 <= int(parts[1]) < 16
        and parts[2] in FORECAST_FIELDS
    )


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
    def collect_component(node: Any, node_path: str) -> None:
        if not isinstance(node, dict):
            return
        if isinstance(node.get("action"), dict):
            actions.append((node["action"], f"{node_path}.action"))
        for index, child in enumerate(node.get("children", [])):
            collect_component(child, f"{node_path}.children[{index}]")

    collect_component(block.get("component"), f"{path}.component")
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
    if isinstance(value, dict) and value.get("op") in EXPRESSION_OPS:
        return True
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
    if block.get("kind") == "vector_icon":
        _validate_vector_icon_budget(block, path, diagnostics)
    for index, node in enumerate(block.get("nodes", [])):
        if isinstance(node.get("vector_icon"), dict):
            _validate_vector_icon_budget(node["vector_icon"], f"{path}.nodes[{index}].vector_icon", diagnostics)


def _validate_vector_icon_budget(
    icon: dict[str, Any], path: str, diagnostics: list[dict[str, Any]]
) -> None:
    art = (
        icon.get("render_budget") == "art"
        or icon.get("renderBudget") == "art"
        or icon.get("performance_budget") == "art"
        or icon.get("performanceBudget") == "art"
    )
    limits = {
        "shapes": 120 if art else 48,
        "gradients": 24 if art else 8,
        "depth": 3 if art else 2,
    }
    if len(icon.get("gradients", [])) > limits["gradients"]:
        _diagnostic(
            diagnostics,
            f"{path}.gradients",
            "budget.gradients",
            "Vector icon exceeds its gradient budget.",
            f"Keep at most {limits['gradients']} gradients.",
        )
    if len(icon.get("shapes", [])) > limits["shapes"]:
        _diagnostic(
            diagnostics,
            f"{path}.shapes",
            "budget.shapes",
            "Vector icon exceeds its shape budget.",
            f"Keep at most {limits['shapes']} top-level shapes.",
        )
    for index, shape in enumerate(icon.get("shapes", [])):
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
