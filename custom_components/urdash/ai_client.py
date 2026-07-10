from __future__ import annotations

import asyncio
import json
from typing import Any

import yaml

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .action_policy import ACTION_SCHEMA
from .card_validator import (
    build_strict_provider_schema,
    format_diagnostics,
    has_errors,
    migrate_card_config,
    strip_provider_nulls,
    validate_card_config,
)
from .capabilities import CAPABILITY_DESCRIPTOR_VERSION, build_entity_capability_descriptors
from .const import DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL

SYSTEM_PROMPT = """You are UrDash v2, a Home Assistant custom-card designer.
Create one safe, declarative UrDash card spec for a Lovelace custom card.
Return only structured JSON matching the requested schema.
Do not generate JavaScript, HTML, CSS, markdown, or ordinary Lovelace cards.
Use only entity IDs from the provided entity list.
Each entity includes a versioned capability descriptor. Use it to understand the device, current values, supported operations, parameter ranges, options, and risk. Never invent a capability. An operation must also be permitted by the output action schema before it can be used as an action.
Design the card before composing blocks: choose the user's task, visible state, one-tap actions, secondary context, risky actions, and a layout that makes the card useful.
Cards may combine multiple device functions when it helps the user's goal.
Design expressive card experiences, not just block grids. Use canvas layout, floating primitives, hero values, ambient layers, orbit/constellation compositions, visual maps, strips, and unframed surfaces when they improve the card.
Use visual_map when the user asks for flows, relationships, topology, spatial control, power movement, irrigation paths, security perimeters, HVAC air movement, or any card that benefits from AI-designed nodes and links. Do not use predefined layouts; choose node positions and link paths based on the user's goal and the available entities.
For polished smart-home topology cards, visual_map can use ring nodes, node stats, connection anchors, manual path points, flow dots, and hidden link labels. Use these to create clear energy, water, HVAC, network, security, and appliance-flow displays without hardcoded templates.
Design cards for both desktop and mobile. Canvas cards should remain readable around 350px wide; use layout.responsive.mobile.aspect_ratio and block responsive.mobile.frame when the mobile composition needs different spacing.
Use vector_icon when a custom symbol is useful, including inside visual_map nodes through nodes[].vector_icon. It is declarative only: compose safe path/circle/ellipse/rect/line/polyline/group shapes, optional declarative gradients, ordered transform stacks, matrix gradient transforms, numeric coordinate_mode, off-canvas user-space gradient focal points, blend modes, glow/neon/blur/color effects, safe filter presets, and safe preset or keyframe animations; never raw SVG, HTML, scripts, styles, images, filters, or external references.
For premium glow, prefer layered radial gradients with userSpaceOnUse or numeric coordinate_mode, focal points, matrix/scale transforms, blend modes, and safe filter_preset values. For design-tool-style art, set vector_icon render_budget to art, viewBox to the source coordinate space, and coordinate_mode to number. Avoid animating shapes that use heavy blur/glow/neon effects; animate transform or opacity on gradient-filled shapes instead.
Prefer direct, usable controls over decorative blocks, but make the interface visually distinctive.
Use declarative animation presets only when they improve clarity.
Use bounded declarative expressions for derived values, labels, icons, colors, visibility, animation state, and action parameters. Expressions are JSON AST objects, never source code. Prefer direct entity bindings for simple values and expressions when they add meaningful aggregation, mapping, formatting, or conditional behavior.
For a multi-day or hourly weather card, declare card.data_sources with type weather_forecast, the selected weather entity, one advertised forecast_type, and a bounded limit. Read entries with source expressions such as {"op":"source","source_id":"home_daily","path":"forecast.0.temperature"}. Use condition mapping for icons and colors, format_datetime for labels, and concat for high/low temperature or precipitation text. Do not invent forecast sensor entities.
"""

EXPRESSION_REF: dict[str, Any] = {"$ref": "#/$defs/expression"}
SAFE_SCALAR_SCHEMA: dict[str, Any] = {
    "anyOf": [
        {"type": "string"},
        {"type": "number"},
        {"type": "boolean"},
        {"type": "null"},
    ]
}
EXPRESSION_CASE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["when", "value"],
    "properties": {"when": SAFE_SCALAR_SCHEMA, "value": EXPRESSION_REF},
}
EXPRESSION_DEFINITION: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["op"],
    "properties": {
        "op": {
            "type": "string",
            "enum": [
                "literal", "entity", "local", "add", "subtract", "multiply", "divide",
                "modulo", "min", "max", "average", "sum", "clamp", "round", "percentage",
                "eq", "ne", "gt", "gte", "lt", "lte", "and", "or", "not", "if",
                "coalesce", "map", "format_number", "format_datetime", "format_duration",
                "relative_time", "convert_unit", "concat", "source",
            ],
        },
        "value": SAFE_SCALAR_SCHEMA,
        "entity_id": {"type": "string"},
        "source_id": {"type": "string"},
        "path": {"type": "string"},
        "name": {"type": "string", "enum": ["selected", "value", "current"]},
        "args": {"type": "array", "maxItems": 16, "items": EXPRESSION_REF},
        "condition": EXPRESSION_REF,
        "then": EXPRESSION_REF,
        "else": EXPRESSION_REF,
        "cases": {"type": "array", "maxItems": 32, "items": EXPRESSION_CASE_SCHEMA},
        "default": EXPRESSION_REF,
        "min": {"type": "number"},
        "max": {"type": "number"},
        "decimals": {"type": "integer", "minimum": 0, "maximum": 6},
        "from_unit": {"type": "string"},
        "to_unit": {"type": "string"},
        "style": {"type": "string", "enum": ["decimal", "percent", "currency", "unit", "short", "medium", "long", "full", "weekday_short", "weekday_long", "time_short"]},
        "prefix": {"type": "string"},
        "suffix": {"type": "string"},
        "locale": {"type": "string"},
        "currency": {"type": "string"},
        "unit": {"type": "string"},
    },
}
DISPLAY_VALUE_SCHEMA: dict[str, Any] = {
    "anyOf": [{"type": "string"}, {"type": "number"}, {"type": "boolean"}, EXPRESSION_REF]
}

DATA_SOURCE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["id", "type", "entity", "forecast_type"],
    "properties": {
        "id": {"type": "string"},
        "type": {"type": "string", "enum": ["weather_forecast"]},
        "entity": {"type": "string"},
        "forecast_type": {"type": "string", "enum": ["daily", "hourly", "twice_daily"]},
        "limit": {"type": "integer", "minimum": 1, "maximum": 16},
    },
}

STYLE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "tone": {"anyOf": [{"type": "string", "enum": ["neutral", "calm", "warm", "cool", "alert", "success"]}, EXPRESSION_REF]},
        "emphasis": {"anyOf": [{"type": "string", "enum": ["low", "normal", "high", "hero"]}, EXPRESSION_REF]},
        "shape": {"anyOf": [{"type": "string", "enum": ["none", "soft", "pill", "circle"]}, EXPRESSION_REF]},
        "density": {"anyOf": [{"type": "string", "enum": ["compact", "comfortable", "spacious"]}, EXPRESSION_REF]},
        "accent": DISPLAY_VALUE_SCHEMA,
    },
}

VISUAL_NODE_STYLE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "accent": DISPLAY_VALUE_SCHEMA,
        "shape": {"type": "string", "enum": ["none", "soft", "pill", "circle", "orb", "core", "ring"]},
        "ring_width": {"type": "string", "enum": ["thin", "normal", "thick"]},
        "tone": {"type": "string", "enum": ["neutral", "calm", "warm", "cool", "alert", "success"]},
        "emphasis": {"type": "string", "enum": ["low", "normal", "high", "hero"]},
    },
}

VISUAL_LINK_STYLE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "accent": DISPLAY_VALUE_SCHEMA,
        "width": {"anyOf": [{"type": "number"}, {"type": "string", "enum": ["dynamic"]}]},
        "curve": {"type": "string", "enum": ["straight", "soft", "arc"]},
        "animated": {"anyOf": [{"type": "boolean"}, EXPRESSION_REF]},
        "direction": {"type": "string", "enum": ["forward", "reverse", "none"]},
        "flow_dot": {"type": "boolean"},
        "dot_size": {"type": "number"},
    },
}

VISUAL_POINT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["x", "y"],
    "properties": {
        "x": {"type": "number"},
        "y": {"type": "number"},
    },
}

FRAME_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["x", "y", "w", "h"],
    "properties": {
        "x": {"type": "number"},
        "y": {"type": "number"},
        "w": {"type": "number"},
        "h": {"type": "number"},
    },
}

BLOCK_RESPONSIVE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "mobile": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "frame": FRAME_SCHEMA,
            },
        },
    },
}

LAYOUT_RESPONSIVE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "mobile": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "aspect_ratio": {"type": "string"},
            },
        },
    },
}

VECTOR_POINT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["x", "y"],
    "properties": {
        "x": {"type": "number"},
        "y": {"type": "number"},
    },
}

VECTOR_ANIMATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "preset": {
            "type": "string",
            "enum": ["none", "pulse", "breathe", "spin", "orbit", "rain_drop", "drift", "dash_flow", "draw", "twinkle", "fade", "shimmer"],
        },
        "delay": {"type": "number", "minimum": 0, "maximum": 8},
        "duration": {"type": "number", "minimum": 0.5, "maximum": 30},
        "repeat": {
            "anyOf": [
                {"type": "boolean"},
                {"type": "integer", "minimum": 1, "maximum": 20},
            ]
        },
        "phase_offset": {"type": "number", "minimum": 0, "maximum": 30},
        "phaseOffset": {"type": "number", "minimum": 0, "maximum": 30},
        "property": {"type": "string", "enum": ["opacity", "rotate", "scale", "translate"]},
        "easing": {"type": "string", "enum": ["linear", "ease", "ease_in", "ease_out", "ease_in_out"]},
        "speed": {"type": "string", "enum": ["slow", "normal", "fast"]},
        "intensity": {"type": "string", "enum": ["subtle", "normal", "strong"]},
        "origin": VECTOR_POINT_SCHEMA,
        "keyframes": {
            "type": "array",
            "maxItems": 8,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "offset": {"type": "number", "minimum": 0, "maximum": 1},
                    "value": {"type": "number"},
                    "opacity": {"type": "number", "minimum": 0, "maximum": 1},
                    "angle": {"type": "number", "minimum": -360, "maximum": 360},
                    "rotate": {"type": "number", "minimum": -360, "maximum": 360},
                    "scale": {"type": "number", "minimum": 0.1, "maximum": 4},
                    "scale_x": {"type": "number", "minimum": 0.1, "maximum": 4},
                    "scale_y": {"type": "number", "minimum": 0.1, "maximum": 4},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "translate_x": {"type": "number"},
                    "translate_y": {"type": "number"},
                },
            },
        },
    },
}

VECTOR_TRANSFORM_STEP_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "type": {"type": "string", "enum": ["matrix", "translate", "rotate", "scale", "skew_x", "skew_y"]},
        "a": {"type": "number", "minimum": -4, "maximum": 4},
        "b": {"type": "number", "minimum": -4, "maximum": 4},
        "c": {"type": "number", "minimum": -4, "maximum": 4},
        "d": {"type": "number", "minimum": -4, "maximum": 4},
        "e": {"type": "number", "minimum": -5000, "maximum": 5000},
        "f": {"type": "number", "minimum": -5000, "maximum": 5000},
        "x": {"type": "number"},
        "y": {"type": "number"},
        "angle": {"type": "number", "minimum": -360, "maximum": 360},
        "rotate": {"type": "number", "minimum": -360, "maximum": 360},
        "scale": {"type": "number", "minimum": 0.1, "maximum": 4},
        "scale_x": {"type": "number", "minimum": 0.1, "maximum": 4},
        "scale_y": {"type": "number", "minimum": 0.1, "maximum": 4},
        "origin": VECTOR_POINT_SCHEMA,
    },
}

VECTOR_TRANSFORM_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "rotate": {"type": "number", "minimum": -360, "maximum": 360},
        "scale": {"type": "number", "minimum": 0.1, "maximum": 4},
        "scale_x": {"type": "number", "minimum": 0.1, "maximum": 4},
        "scale_y": {"type": "number", "minimum": 0.1, "maximum": 4},
        "translate_x": {"type": "number", "minimum": -100, "maximum": 100},
        "translate_y": {"type": "number", "minimum": -100, "maximum": 100},
        "skew_x": {"type": "number", "minimum": -60, "maximum": 60},
        "skew_y": {"type": "number", "minimum": -60, "maximum": 60},
        "origin": VECTOR_POINT_SCHEMA,
        "matrix": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "a": {"type": "number", "minimum": -4, "maximum": 4},
                "b": {"type": "number", "minimum": -4, "maximum": 4},
                "c": {"type": "number", "minimum": -4, "maximum": 4},
                "d": {"type": "number", "minimum": -4, "maximum": 4},
                "e": {"type": "number", "minimum": -5000, "maximum": 5000},
                "f": {"type": "number", "minimum": -5000, "maximum": 5000},
            },
        },
        "transforms": {"type": "array", "maxItems": 8, "items": VECTOR_TRANSFORM_STEP_SCHEMA},
        "stack": {"type": "array", "maxItems": 8, "items": VECTOR_TRANSFORM_STEP_SCHEMA},
    },
}

VECTOR_GLOW_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "color": {"type": "string"},
        "size": {"type": "number", "minimum": 0, "maximum": 40},
        "opacity": {"type": "number", "minimum": 0, "maximum": 1},
    },
}

VECTOR_EFFECTS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "blur": {"type": "number", "minimum": 0, "maximum": 16},
        "brightness": {"type": "number", "minimum": 0.2, "maximum": 3},
        "saturate": {"type": "number", "minimum": 0.2, "maximum": 3},
        "filter_preset": {"type": "string", "enum": ["none", "soft_blur", "outer_glow", "inner_glow", "bloom", "colored_shadow", "luminous_ring", "svg_blur", "svg_white_neon"]},
        "filterPreset": {"type": "string", "enum": ["none", "soft_blur", "outer_glow", "inner_glow", "bloom", "colored_shadow", "luminous_ring", "svg_blur", "svg_white_neon"]},
        "std_deviation": {"type": "number", "minimum": 0, "maximum": 24},
        "stdDeviation": {"type": "number", "minimum": 0, "maximum": 24},
        "color": {"type": "string"},
        "accent": {"type": "string"},
        "opacity": {"type": "number", "minimum": 0, "maximum": 1},
        "glow": VECTOR_GLOW_SCHEMA,
        "neon_glow": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "color": {"type": "string"},
                "size": {"type": "number", "minimum": 0, "maximum": 48},
                "opacity": {"type": "number", "minimum": 0, "maximum": 1},
                "layers": {"type": "integer", "minimum": 1, "maximum": 4},
            },
        },
    },
}

VECTOR_GRADIENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["id", "type", "stops"],
    "properties": {
        "id": {"type": "string"},
        "type": {"type": "string", "enum": ["linear", "radial"]},
        "units": {"type": "string", "enum": ["objectBoundingBox", "userSpaceOnUse"]},
        "coordinate_mode": {"type": "string", "enum": ["percent", "number"]},
        "coordinateMode": {"type": "string", "enum": ["percent", "number"]},
        "spread_method": {"type": "string", "enum": ["pad", "reflect", "repeat"]},
        "from": VECTOR_POINT_SCHEMA,
        "to": VECTOR_POINT_SCHEMA,
        "center": VECTOR_POINT_SCHEMA,
        "focal": VECTOR_POINT_SCHEMA,
        "fx": {"type": "number"},
        "fy": {"type": "number"},
        "fr": {"type": "number"},
        "radius": {"type": "number"},
        "rotation": {"type": "number", "minimum": -360, "maximum": 360},
        "transform": VECTOR_TRANSFORM_SCHEMA,
        "stops": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["offset", "color"],
                "properties": {
                    "offset": {"type": "number", "minimum": 0, "maximum": 1},
                    "color": {"type": "string"},
                    "opacity": {"type": "number", "minimum": 0, "maximum": 1},
                },
            },
        },
    },
}

VECTOR_SHAPE_COMMON_PROPERTIES: dict[str, Any] = {
    "d": {"type": "string"},
    "cx": {"type": "number"},
    "cy": {"type": "number"},
    "r": {"type": "number"},
    "x": {"type": "number"},
    "y": {"type": "number"},
    "width": {"type": "number"},
    "height": {"type": "number"},
    "rx": {"type": "number"},
    "ry": {"type": "number"},
    "x1": {"type": "number"},
    "y1": {"type": "number"},
    "x2": {"type": "number"},
    "y2": {"type": "number"},
    "points": {"type": "array", "items": VECTOR_POINT_SCHEMA},
    "fill": {"type": "string"},
    "stroke": {"type": "string"},
    "stroke_width": {"type": "number"},
    "stroke_dasharray": {
        "anyOf": [
            {"type": "string"},
            {"type": "array", "items": {"type": "number"}, "maxItems": 4},
        ]
    },
    "stroke_linecap": {"type": "string", "enum": ["butt", "round", "square"]},
    "stroke_linejoin": {"type": "string", "enum": ["miter", "round", "bevel"]},
    "stroke_miterlimit": {"type": "number", "minimum": 1, "maximum": 20},
    "opacity": {"type": "number"},
    "coordinate_mode": {"type": "string", "enum": ["percent", "number"]},
    "coordinateMode": {"type": "string", "enum": ["percent", "number"]},
    "rotation": {"type": "number", "minimum": -360, "maximum": 360},
    "transform": VECTOR_TRANSFORM_SCHEMA,
    "transform_origin": VECTOR_POINT_SCHEMA,
    "transformOrigin": VECTOR_POINT_SCHEMA,
    "blend_mode": {"type": "string", "enum": ["normal", "screen", "plus-lighter", "soft-light", "overlay", "color-dodge", "hard-light", "lighten"]},
    "effects": VECTOR_EFFECTS_SCHEMA,
    "animation": VECTOR_ANIMATION_SCHEMA,
}

VECTOR_CHILD_SHAPE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["type"],
    "properties": {
        "type": {"type": "string", "enum": ["path", "circle", "ellipse", "rect", "line", "polyline"]},
        **VECTOR_SHAPE_COMMON_PROPERTIES,
    },
}

VECTOR_SHAPE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["type"],
    "properties": {
        "type": {"type": "string", "enum": ["path", "circle", "ellipse", "rect", "line", "polyline", "group"]},
        **VECTOR_SHAPE_COMMON_PROPERTIES,
        "origin": VECTOR_POINT_SCHEMA,
        "shapes": {"type": "array", "items": VECTOR_CHILD_SHAPE_SCHEMA},
    },
}

VECTOR_ICON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "viewBox": {"type": "string"},
        "coordinate_mode": {"type": "string", "enum": ["percent", "number"]},
        "coordinateMode": {"type": "string", "enum": ["percent", "number"]},
        "render_budget": {"type": "string", "enum": ["normal", "art"]},
        "renderBudget": {"type": "string", "enum": ["normal", "art"]},
        "performance_budget": {"type": "string", "enum": ["normal", "art"]},
        "performanceBudget": {"type": "string", "enum": ["normal", "art"]},
        "gradients": {"type": "array", "items": VECTOR_GRADIENT_SCHEMA},
        "shapes": {"type": "array", "items": VECTOR_SHAPE_SCHEMA},
        "style": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "accent": {"type": "string"},
            },
        },
    },
}

VISUAL_BIND_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "value": DISPLAY_VALUE_SCHEMA,
        "unit": DISPLAY_VALUE_SCHEMA,
    },
}

VISUAL_STAT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["entity"],
    "properties": {
        "entity": {"type": "string"},
        "prefix": DISPLAY_VALUE_SCHEMA,
        "suffix": DISPLAY_VALUE_SCHEMA,
        "unit": DISPLAY_VALUE_SCHEMA,
        "tone": {"type": "string", "enum": ["neutral", "positive", "negative", "muted"]},
        "bind": VISUAL_BIND_SCHEMA,
    },
}

VISUAL_MAP_NODE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["id", "label", "position"],
    "properties": {
        "id": {"type": "string"},
        "label": DISPLAY_VALUE_SCHEMA,
        "value": DISPLAY_VALUE_SCHEMA,
        "entity": {"type": "string"},
        "icon": DISPLAY_VALUE_SCHEMA,
        "vector_icon": VECTOR_ICON_SCHEMA,
        "size": {"type": "string", "enum": ["micro", "small", "normal", "large", "hero"]},
        "position": {
            "type": "object",
            "additionalProperties": False,
            "required": ["x", "y"],
            "properties": {
                "x": {"type": "number"},
                "y": {"type": "number"},
            },
        },
        "bind": {
            **VISUAL_BIND_SCHEMA,
        },
        "stats": {"type": "array", "items": VISUAL_STAT_SCHEMA},
        "style": VISUAL_NODE_STYLE_SCHEMA,
        "action": ACTION_SCHEMA,
    },
}

VISUAL_ANCHOR_VALUES = [
    "center",
    "top",
    "right",
    "bottom",
    "left",
    "top_left",
    "top_right",
    "bottom_left",
    "bottom_right",
]

VISUAL_MAP_LINK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["from", "to"],
    "properties": {
        "from": {"type": "string"},
        "to": {"type": "string"},
        "from_anchor": {"type": "string", "enum": VISUAL_ANCHOR_VALUES},
        "to_anchor": {"type": "string", "enum": VISUAL_ANCHOR_VALUES},
        "label": DISPLAY_VALUE_SCHEMA,
        "show_label": {"type": "boolean"},
        "label_position": VISUAL_POINT_SCHEMA,
        "flow_position": VISUAL_POINT_SCHEMA,
        "entity": {"type": "string"},
        "path": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "points": {"type": "array", "items": VISUAL_POINT_SCHEMA},
            },
        },
        "bind": VISUAL_BIND_SCHEMA,
        "style": VISUAL_LINK_STYLE_SCHEMA,
    },
}

ANIMATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "preset": {
            "type": "string",
            "enum": [
                "none",
                "pulse",
                "breathe",
                "glow",
                "float",
                "shimmer",
                "progress",
                "orbit",
                "wave",
                "count_up",
                "state_flash",
                "slide_in",
                "fade_in",
            ],
        },
        "trigger": {
            "type": "string",
            "enum": ["always", "on_load", "on_state_change", "state_on", "state_alert", "on_hover"],
        },
        "speed": {"type": "string", "enum": ["slow", "normal", "fast"]},
        "intensity": {"type": "string", "enum": ["subtle", "normal", "strong"]},
        "active": {"anyOf": [{"type": "boolean"}, EXPRESSION_REF]},
    },
}

PRESENTATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "surface": {
            "type": "string",
            "enum": ["panel", "glass", "ghost", "naked", "hero", "floating", "orb", "strip", "rail"],
        },
        "scale": {"type": "string", "enum": ["micro", "small", "normal", "large", "xl", "full"]},
        "align": {"type": "string", "enum": ["start", "center", "end", "stretch"]},
        "layer": {"type": "string", "enum": ["backdrop", "base", "raised", "overlay"]},
    },
}

BLOCK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["id", "kind"],
    "properties": {
        "id": {"type": "string"},
        "kind": {
            "type": "string",
            "enum": [
                "text",
                "icon",
                "vector_icon",
                "value",
                "value_cluster",
                "entity_list",
                "button",
                "button_group",
                "toggle_group",
                "segmented_control",
                "slider",
                "climate_control",
                "cover_control",
                "security_cluster",
                "scene_strip",
                "gauge",
                "radial_meter",
                "timeline",
                "sparkline",
                "divider",
                "chip_group",
                "hero_value",
                "ambient",
                "entity_orbit",
                "constellation",
                "radial_scene",
                "visual_map",
            ],
        },
        "title": DISPLAY_VALUE_SCHEMA,
        "subtitle": DISPLAY_VALUE_SCHEMA,
        "text": DISPLAY_VALUE_SCHEMA,
        "variant": {"type": "string", "enum": ["label", "body", "headline", "display", "title", "caption"]},
        "label": DISPLAY_VALUE_SCHEMA,
        "icon": DISPLAY_VALUE_SCHEMA,
        "viewBox": {"type": "string"},
        "coordinate_mode": {"type": "string", "enum": ["percent", "number"]},
        "coordinateMode": {"type": "string", "enum": ["percent", "number"]},
        "render_budget": {"type": "string", "enum": ["normal", "art"]},
        "renderBudget": {"type": "string", "enum": ["normal", "art"]},
        "performance_budget": {"type": "string", "enum": ["normal", "art"]},
        "performanceBudget": {"type": "string", "enum": ["normal", "art"]},
        "gradients": {"type": "array", "items": VECTOR_GRADIENT_SCHEMA},
        "shapes": {"type": "array", "items": VECTOR_SHAPE_SCHEMA},
        "entity": {"type": "string"},
        "entities": {"type": "array", "items": {"type": "string"}},
        "bind": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "value": DISPLAY_VALUE_SCHEMA,
                "label": DISPLAY_VALUE_SCHEMA,
                "unit": DISPLAY_VALUE_SCHEMA,
            },
        },
        "grid": {
            "type": "object",
            "additionalProperties": False,
            "required": ["col", "row", "w", "h"],
            "properties": {
                "col": {"type": "integer", "minimum": 1},
                "row": {"type": "integer", "minimum": 1},
                "w": {"type": "integer", "minimum": 1},
                "h": {"type": "integer", "minimum": 1},
            },
        },
        "frame": FRAME_SCHEMA,
        "responsive": BLOCK_RESPONSIVE_SCHEMA,
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["entity", "label", "value"],
                "properties": {
                    "entity": {"type": "string"},
                    "label": DISPLAY_VALUE_SCHEMA,
                    "value": DISPLAY_VALUE_SCHEMA,
                    "unit": DISPLAY_VALUE_SCHEMA,
                },
            },
        },
        "buttons": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["label", "action"],
                "properties": {
                    "label": DISPLAY_VALUE_SCHEMA,
                    "icon": DISPLAY_VALUE_SCHEMA,
                    "action": ACTION_SCHEMA,
                },
            },
        },
        "chips": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["label"],
                "properties": {
                    "label": DISPLAY_VALUE_SCHEMA,
                    "entity": {"type": "string"},
                    "icon": DISPLAY_VALUE_SCHEMA,
                },
            },
        },
        "options": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["label", "value"],
                "properties": {
                    "label": {"type": "string"},
                    "value": {"type": "string"},
                },
            },
        },
        "features": {"type": "array", "items": {"type": "string"}},
        "range": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "min": {"type": "number"},
                "max": {"type": "number"},
                "step": {"type": "number"},
                "hours": {"type": "number"},
            },
        },
        "action": ACTION_SCHEMA,
        "actions": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["label", "entity_id"],
                "properties": {
                    "label": {"type": "string"},
                    "icon": {"type": "string"},
                    "entity_id": {"type": "string"},
                },
            },
        },
        "nodes": {"type": "array", "items": VISUAL_MAP_NODE_SCHEMA},
        "links": {"type": "array", "items": VISUAL_MAP_LINK_SCHEMA},
        "style": STYLE_SCHEMA,
        "presentation": PRESENTATION_SCHEMA,
        "animation": ANIMATION_SCHEMA,
        "visibility": {
            "type": "object",
            "additionalProperties": False,
            "required": [],
            "properties": {
                "entity": {"type": "string"},
                "operator": {"type": "string", "enum": ["equals", "not_equals", "in", "not_in", "exists"]},
                "expression": EXPRESSION_REF,
                "value": {
                    "anyOf": [
                        {"type": "string"},
                        {"type": "number"},
                        {"type": "boolean"},
                        {"type": "array", "items": {"type": "string"}},
                    ]
                },
            },
        },
    },
}

CARD_V2_SCHEMA: dict[str, Any] = {
    "$defs": {"expression": EXPRESSION_DEFINITION},
    "type": "object",
    "additionalProperties": False,
    "required": ["type", "urdash_schema", "height_mode", "card"],
    "properties": {
        "type": {"type": "string", "enum": ["custom:urdash-card"]},
        "urdash_schema": {"type": "integer", "enum": [2]},
        "urdash_schema_minor": {"type": "integer", "minimum": 0, "maximum": 0},
        "preview": {"type": "boolean"},
        "preview_mode": {"type": "boolean"},
        "height_mode": {"type": "string", "enum": ["auto", "viewport", "fixed"]},
        "height": {"type": "integer", "minimum": 240, "maximum": 1200},
        "card": {
            "type": "object",
            "additionalProperties": False,
            "required": ["intent", "layout"],
            "properties": {
                "data_sources": {"type": "array", "maxItems": 4, "items": DATA_SOURCE_SCHEMA},
                "intent": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["goal", "title", "summary", "risk_level", "primary_entities", "primary_actions"],
                    "properties": {
                        "goal": {
                            "type": "string",
                            "enum": [
                                "sensor_summary",
                                "weather",
                                "room_control",
                                "climate_control",
                                "security",
                                "energy",
                                "hero_visual",
                                "scene_launcher",
                                "media_control",
                                "multi_device_control",
                            ],
                        },
                        "title": {"type": "string"},
                        "summary": {"type": "string"},
                        "risk_level": {"type": "string", "enum": ["low", "medium", "high"]},
                        "primary_entities": {"type": "array", "items": {"type": "string"}},
                        "primary_actions": {"type": "array", "items": {"type": "string"}},
                    },
                },
                "layout": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["type", "blocks"],
                    "properties": {
                        "type": {"type": "string", "enum": ["grid", "canvas"]},
                        "chrome": {"type": "string", "enum": ["normal", "art"]},
                        "columns": {"type": "integer", "minimum": 4, "maximum": 16},
                        "density": {"type": "string", "enum": ["compact", "comfortable", "spacious"]},
                        "theme": {"type": "string", "enum": ["aurora", "quiet", "graphite", "calm", "sunrise"]},
                        "aspect_ratio": {"type": "string"},
                        "mobile_aspect_ratio": {"type": "string"},
                        "responsive": LAYOUT_RESPONSIVE_SCHEMA,
                        "blocks": {"type": "array", "items": BLOCK_SCHEMA},
                    },
                },
            },
        },
    },
}

GENERATION_SCHEMA: dict[str, Any] = {
    "$defs": {"expression": EXPRESSION_DEFINITION},
    "type": "object",
    "additionalProperties": False,
    "required": ["card_config", "summary", "notes"],
    "properties": {
        "card_config": CARD_V2_SCHEMA,
        "summary": {"type": "string"},
        "notes": {"type": "array", "items": {"type": "string"}},
    },
}
STRICT_GENERATION_SCHEMA = build_strict_provider_schema(GENERATION_SCHEMA)


class AiGenerationError(Exception):
    """Raised when AI generation fails."""


async def async_generate_with_openai(
    hass: HomeAssistant,
    *,
    api_key: str,
    base_url: str,
    model: str,
    request: str,
    entities: list[dict[str, Any]],
    available_services: set[str] | None,
    theme: str,
    height_mode: str,
    _repair_attempt: bool = False,
) -> dict[str, Any]:
    """Generate a v2 UrDash card with the OpenAI Responses API."""
    if not api_key:
        raise AiGenerationError("OpenAI API key is not configured.")

    payload = {
        "model": model or DEFAULT_OPENAI_MODEL,
        "input": [
            {"role": "system", "content": [{"type": "input_text", "text": SYSTEM_PROMPT}]},
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": json.dumps(
                            {
                                "request": request,
                                "preferred_theme": theme,
                                "height_mode": height_mode,
                                "entity_capability_schema": CAPABILITY_DESCRIPTOR_VERSION,
                                "entities": _compact_entities(entities, available_services),
                                "requirements": _requirements(),
                            },
                            separators=(",", ":"),
                        ),
                    }
                ],
            },
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "urdash_card_v2",
                "schema": STRICT_GENERATION_SCHEMA,
                "strict": True,
            }
        },
    }

    session = async_get_clientsession(hass)
    url = f"{(base_url or DEFAULT_OPENAI_BASE_URL).rstrip('/')}/responses"

    try:
        async with asyncio.timeout(60):
            response = await session.post(
                url,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
            response_text = await response.text()
    except TimeoutError as err:
        raise AiGenerationError("AI request timed out.") from err

    if response.status >= 400:
        raise AiGenerationError(f"AI provider returned HTTP {response.status}: {response_text[:240]}")

    try:
        response_json = json.loads(response_text)
        output_text = _extract_output_text(response_json)
        generated = strip_provider_nulls(json.loads(output_text))
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as err:
        raise AiGenerationError("AI provider returned an unexpected response.") from err

    card_config = generated.get("card_config")
    if not isinstance(card_config, dict) or card_config.get("urdash_schema") != 2:
        raise AiGenerationError("AI provider returned an invalid UrDash v2 card.")
    card_config = migrate_card_config(card_config)

    diagnostics = validate_card_config(
        card_config,
        CARD_V2_SCHEMA,
        entities=entities,
        available_services=available_services,
    )
    if has_errors(diagnostics):
        if not _repair_attempt:
            repaired = await async_generate_with_openai(
                hass,
                api_key=api_key,
                base_url=base_url,
                model=model,
                request=(
                    f"{request}\n\nThe previous card failed UrDash validation. "
                    "Generate a corrected replacement that resolves every diagnostic: "
                    f"{json.dumps(diagnostics[:12], ensure_ascii=False)}"
                ),
                entities=entities,
                available_services=available_services,
                theme=theme,
                height_mode=height_mode,
                _repair_attempt=True,
            )
            repaired["repaired"] = True
            return repaired
        raise AiGenerationError(
            f"AI provider returned an invalid UrDash card: {format_diagnostics(diagnostics)}"
        )

    card_config["type"] = "custom:urdash-card"
    card_config["height_mode"] = height_mode if height_mode in {"auto", "viewport", "fixed"} else "auto"
    layout = card_config.get("card", {}).get("layout", {})
    if isinstance(layout, dict) and theme in {"aurora", "quiet", "graphite", "calm", "sunrise"}:
        layout["theme"] = layout.get("theme") or theme

    yaml_value = yaml.safe_dump(card_config, allow_unicode=True, sort_keys=False).strip()
    return {
        "card_config": card_config,
        "yaml": yaml_value,
        "json": json.dumps(card_config, ensure_ascii=False, indent=2),
        "summary": generated.get("summary", "Generated with AI."),
        "notes": generated.get("notes", []),
        "engine": "ai",
        "schema": 2,
        "model": model or DEFAULT_OPENAI_MODEL,
        "diagnostics": diagnostics,
    }


def _requirements() -> list[str]:
    return [
        "Return exactly one Lovelace custom card config with type custom:urdash-card.",
        "Set urdash_schema to 2.",
        "Set height_mode to the requested height mode.",
        "Use only card.layout.blocks for the visual composition.",
        "Use card.intent to state the task, risk, primary entities, and primary actions.",
        "Use card.layout.blocks to compose the UI with safe primitives.",
        "Do not default to simple block-style UI. Prefer a designed composition with one strong focal area and supporting controls.",
        "Use canvas layout for fancy, spatial, or futuristic cards. Use grid layout only when utility and scanning are more important.",
        "Use presentation.surface to vary the visual treatment: naked, ghost, hero, floating, orb, strip, rail, panel, or glass.",
        "Use hero_value, ambient, entity_orbit, constellation, radial_scene, and visual_map for expressive visual structure when appropriate.",
        "Use vector_icon for custom decorative or semantic symbols; only safe declarative path/circle/ellipse/rect/line/polyline/group shapes, gradients, focal points, numeric coordinate_mode, ordered transform stacks, blend modes, safe filter presets, glow/neon/blur/color effects, and preset or keyframe shape animations are allowed.",
        "Use visual_map for relationship or flow cards. AI owns node positions, node sizes, labels, icons, link routing style, and animation choices; UrDash only renders the safe declarative map.",
        "For visual_map, use stats on nodes when a node needs multiple readings, shape ring for dashboard-style circular meters, anchors and path.points for precise routing, and flow_dot for visible movement along a link.",
        "Use ambient as non-interactive visual depth behind useful controls; do not make decoration the only content.",
        "For climate requests, include climate_control and useful mode/temperature controls.",
        "For room requests, combine controllable devices and key sensors in one card when helpful.",
        "For security requests, make attention states visible and require confirmation for risky actions.",
        "For sensor requests, make the primary value readable and include supporting context.",
        "Use button, button_group, segmented_control, slider, climate_control, cover_control, scene_strip, toggle_group, value, value_cluster, timeline, chip_group, hero_value, entity_orbit, constellation, radial_scene, visual_map, vector_icon, or ambient as needed.",
        "Keep blocks focused. Prefer 4 to 12 blocks unless the user requests a dense card.",
        "Do not invent entity IDs.",
        "Use each entity's capabilities for device-aware design. Do not create controls for operations missing from that entity, and only emit actions permitted by the output action schema.",
        "For weather forecasts, declare a card.data_sources weather_forecast source for the selected weather entity and read forecast items with source expressions. Never invent forecast sensor entities.",
        "Use bounded expression AST objects for safe derived values, multi-entity aggregation, mapping, formatting, visibility, styles, animation state, and action parameters; never emit expression source code.",
        "Use declarative animation presets or vector keyframes only; no CSS, HTML, raw SVG, raw filters, or JavaScript.",
    ]


def _compact_entities(
    entities: list[dict[str, Any]],
    available_services: set[str] | None = None,
) -> list[dict[str, Any]]:
    return build_entity_capability_descriptors(entities, available_services)


def _extract_output_text(response_json: dict[str, Any]) -> str:
    if isinstance(response_json.get("output_text"), str):
        return response_json["output_text"]

    for item in response_json.get("output", []):
        for content in item.get("content", []):
            if content.get("type") in {"output_text", "text"} and isinstance(content.get("text"), str):
                return content["text"]

    raise KeyError("output_text")
