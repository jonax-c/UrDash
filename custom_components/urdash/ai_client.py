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
Use component_tree when the user asks for a Bubble-style control, a compound device control, or a freely composed interactive surface. Build it from nested row, column, stack, wrap, and surface containers with text, icon, value, toggle, slider, button, progress, divider, and spacer components. A component tree is not a predefined layout: design its hierarchy, emphasis, actions, and responsive wrapping for the user's task.
For light controls, compose only controls advertised by that light's capabilities. Use toggle for power, slider with brightness_pct for dimming, slider with color_temp_kelvin and the advertised Kelvin range for white temperature, color_picker with rgb_color for RGB-capable lights, and select with effect for the advertised effect options. Bind brightness from attributes.brightness as a percentage when needed. Do not show unsupported color, temperature, brightness, or effect controls.
Keep long light-control labels and values in a separate row above a full-width slider so the composition remains readable around 350px wide.
For climate controls, prefer a freely designed component_tree over the climate_control convenience macro. Use only advertised capabilities: HVAC mode select, one target-temperature slider or paired low/high sliders, target-humidity slider, and selects for fan, preset, vertical swing, and horizontal swing. Use the entity's min, max, step, and option values exactly. For a temperature range action, always submit both target_temp_low and target_temp_high so Home Assistant receives a valid pair.
For fan controls, compose only advertised capabilities: toggle for power, percentage slider with percentage_step, select for preset_modes, an attribute-bound toggle for attributes.oscillating, and a select for direction. For the oscillation action, bind the toggle value to attributes.oscillating and pass the local value as the oscillating parameter. Do not display unsupported controls.
For cover controls, compose only advertised capabilities: open, stop, and close buttons; a current_position slider; tilt open, stop, and close buttons; and a current_tilt_position slider. Use position and tilt_position local values in actions. Make door, garage, and gate opening intent unmistakable because UrDash will require risk confirmation.
For media-player controls, compose only advertised capabilities: transport buttons, volume slider, attribute-bound mute and shuffle toggles, seek slider with an expression-bound media_duration maximum, source and sound-mode selects, and repeat select. Show current title, artist, position, and duration when available. Do not generate browse_media or play_media actions until a safe Home Assistant-local media source is provided.
For security controls, compose alarm, lock, and siren actions only from advertised capabilities. Make armed, triggered, unlocked, open, and unavailable states prominent. Never put an alarm code, PIN, password, token, or credential in card configuration. If a capability has requires_user_code, use more_info instead of a service action. Unlock, disarm, alarm trigger, and siren activation must remain visually explicit because UrDash requires confirmation.
Use visual_map when the user asks for flows, relationships, topology, spatial control, power movement, irrigation paths, security perimeters, HVAC air movement, or any card that benefits from AI-designed nodes and links. Do not use predefined layouts; choose node positions and link paths based on the user's goal and the available entities.
For polished smart-home topology cards, visual_map can use ring nodes, node stats, connection anchors, manual path points, flow dots, and hidden link labels. Use these to create clear energy, water, HVAC, network, security, and appliance-flow displays without hardcoded templates.
Design cards for both desktop and mobile. Canvas cards should remain readable around 350px wide; use layout.responsive.mobile.aspect_ratio and block responsive.mobile.frame when the mobile composition needs different spacing.
Use vector_icon when a custom symbol is useful, including inside visual_map nodes through nodes[].vector_icon. It is declarative only: compose safe path/circle/ellipse/rect/line/polyline/group shapes, optional declarative gradients, ordered transform stacks, matrix gradient transforms, numeric coordinate_mode, off-canvas user-space gradient focal points, blend modes, glow/neon/blur/color effects, safe filter presets, and safe preset or keyframe animations; never raw SVG, HTML, scripts, styles, images, filters, or external references.
For premium glow, prefer layered radial gradients with userSpaceOnUse or numeric coordinate_mode, focal points, matrix/scale transforms, blend modes, and safe filter_preset values. For design-tool-style art, set vector_icon render_budget to art, viewBox to the source coordinate space, and coordinate_mode to number. Avoid animating shapes that use heavy blur/glow/neon effects; animate transform or opacity on gradient-filled shapes instead.
Prefer direct, usable controls over decorative blocks, but make the interface visually distinctive.
Use declarative animation presets only when they improve clarity.
Use bounded declarative expressions for derived values, labels, icons, colors, visibility, animation state, and action parameters. Expressions are JSON AST objects, never source code. Prefer direct entity bindings for simple values and expressions when they add meaningful aggregation, mapping, formatting, or conditional behavior.
For a multi-day or hourly weather card, declare card.data_sources with type weather_forecast, the selected weather entity, one advertised forecast_type, and a bounded limit. Read entries with source expressions such as {"op":"source","source_id":"home_daily","path":"forecast.0.temperature"}. Define one reusable card.assets.icon_sets weather icon set and reference it from every day with icon_ref whose key is the condition source expression. Use format_datetime for labels and concat for high/low temperature or precipitation text. Do not duplicate the icon artwork in every forecast block and do not invent forecast sensor entities.
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

ICON_ASSET_PROPERTIES: dict[str, Any] = {
    "icon": {"type": "string"},
    "vector_icon": VECTOR_ICON_SCHEMA,
}

ICON_ASSET_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": ICON_ASSET_PROPERTIES,
}

ICON_VARIANT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["key"],
    "properties": {"key": {"type": "string"}, **ICON_ASSET_PROPERTIES},
}

ICON_SET_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["id", "variants"],
    "properties": {
        "id": {"type": "string"},
        "variants": {"type": "array", "minItems": 1, "maxItems": 24, "items": ICON_VARIANT_SCHEMA},
        "fallback": ICON_ASSET_SCHEMA,
    },
}

ICON_REF_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["set", "key"],
    "properties": {"set": {"type": "string"}, "key": DISPLAY_VALUE_SCHEMA},
}

COMPONENT_REF: dict[str, Any] = {"$ref": "#/$defs/component"}

COMPONENT_STYLE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "surface": {"type": "string", "enum": ["none", "soft", "glass", "solid", "ghost"]},
        "shape": {"type": "string", "enum": ["square", "soft", "pill", "circle"]},
        "tone": {"type": "string", "enum": ["neutral", "calm", "warm", "cool", "alert", "success"]},
        "emphasis": {"type": "string", "enum": ["low", "normal", "high"]},
        "accent": DISPLAY_VALUE_SCHEMA,
        "size": {"type": "string", "enum": ["xs", "sm", "md", "lg", "xl"]},
        "opacity": {"type": "number", "minimum": 0, "maximum": 1},
    },
}

COMPONENT_LAYOUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "gap": {"type": "string", "enum": ["none", "xs", "sm", "md", "lg"]},
        "direction": {"type": "string", "enum": ["row", "column"]},
        "padding": {"type": "string", "enum": ["none", "xs", "sm", "md", "lg"]},
        "align": {"type": "string", "enum": ["start", "center", "end", "stretch"]},
        "justify": {"type": "string", "enum": ["start", "center", "end", "between", "around"]},
        "width": {"type": "string", "enum": ["auto", "fill", "content"]},
        "grow": {"type": "integer", "minimum": 0, "maximum": 4},
        "placement": {"type": "string", "enum": ["center", "top", "right", "bottom", "left", "top_left", "top_right", "bottom_left", "bottom_right"]},
    },
}

COMPONENT_DEFINITION: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["type"],
    "properties": {
        "id": {"type": "string"},
        "type": {
            "type": "string",
            "enum": [
                "row", "column", "stack", "wrap", "surface", "text", "icon",
                "value", "toggle", "slider", "color_picker", "select", "button",
                "progress", "divider", "spacer",
            ],
        },
        "children": {"type": "array", "maxItems": 16, "items": COMPONENT_REF},
        "text": DISPLAY_VALUE_SCHEMA,
        "label": DISPLAY_VALUE_SCHEMA,
        "value": DISPLAY_VALUE_SCHEMA,
        "unit": DISPLAY_VALUE_SCHEMA,
        "entity": {"type": "string"},
        "bind": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "value": DISPLAY_VALUE_SCHEMA,
                "unit": DISPLAY_VALUE_SCHEMA,
            },
        },
        "icon": DISPLAY_VALUE_SCHEMA,
        "icon_ref": ICON_REF_SCHEMA,
        "action": ACTION_SCHEMA,
        "range": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "min": {"anyOf": [{"type": "number"}, EXPRESSION_REF]},
                "max": {"anyOf": [{"type": "number"}, EXPRESSION_REF]},
                "step": {"anyOf": [{"type": "number"}, EXPRESSION_REF]},
            },
        },
        "options": {
            "type": "array",
            "maxItems": 32,
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
        "style": COMPONENT_STYLE_SCHEMA,
        "layout": COMPONENT_LAYOUT_SCHEMA,
        "disabled": {"anyOf": [{"type": "boolean"}, EXPRESSION_REF]},
        "visibility": {"anyOf": [{"type": "boolean"}, EXPRESSION_REF]},
    },
}

ASSETS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "icon_sets": {"type": "array", "maxItems": 8, "items": ICON_SET_SCHEMA},
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
        "icon_ref": ICON_REF_SCHEMA,
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
        "clip": {"type": "boolean"},
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
                "component_tree",
            ],
        },
        "title": DISPLAY_VALUE_SCHEMA,
        "subtitle": DISPLAY_VALUE_SCHEMA,
        "text": DISPLAY_VALUE_SCHEMA,
        "variant": {"type": "string", "enum": ["label", "body", "headline", "display", "title", "caption"]},
        "label": DISPLAY_VALUE_SCHEMA,
        "icon": DISPLAY_VALUE_SCHEMA,
        "icon_ref": ICON_REF_SCHEMA,
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
                    "icon_ref": ICON_REF_SCHEMA,
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
                    "icon_ref": ICON_REF_SCHEMA,
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
                    "icon_ref": ICON_REF_SCHEMA,
                    "entity_id": {"type": "string"},
                },
            },
        },
        "nodes": {"type": "array", "items": VISUAL_MAP_NODE_SCHEMA},
        "links": {"type": "array", "items": VISUAL_MAP_LINK_SCHEMA},
        "component": COMPONENT_REF,
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
    "$defs": {"expression": EXPRESSION_DEFINITION, "component": COMPONENT_DEFINITION},
    "type": "object",
    "additionalProperties": False,
    "required": ["type", "urdash_schema", "height_mode", "card"],
    "properties": {
        "type": {"type": "string", "enum": ["custom:urdash-card"]},
        "urdash_schema": {"type": "integer", "enum": [2]},
        "urdash_schema_minor": {"type": "integer", "minimum": 0, "maximum": 0},
        "preview": {"type": "boolean"},
        "preview_mode": {"type": "boolean"},
        "stack_position": {"type": "string", "enum": ["single", "top", "middle", "bottom"]},
        "height_mode": {"type": "string", "enum": ["auto", "viewport", "fixed"]},
        "height": {"type": "integer", "minimum": 240, "maximum": 1200},
        "card": {
            "type": "object",
            "additionalProperties": False,
            "required": ["intent", "layout"],
            "properties": {
                "assets": ASSETS_SCHEMA,
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
    "$defs": {"expression": EXPRESSION_DEFINITION, "component": COMPONENT_DEFINITION},
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
    style: str = "auto",
    style_guidance: str = "Choose the most appropriate visual language for this request.",
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
                                "visual_style": {
                                    "id": style,
                                    "guidance": style_guidance,
                                    "layout_constraint": "none",
                                },
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
                style=style,
                style_guidance=style_guidance,
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
        "Use presentation.clip for compact animated artwork that must stay inside its block frame, such as forecast glyphs beside text.",
        "When a card is intended for a native Lovelace vertical-stack, use stack_position top, middle, or bottom to join adjacent UrDash card edges.",
        "Use hero_value, ambient, entity_orbit, constellation, radial_scene, and visual_map for expressive visual structure when appropriate.",
        "Use component_tree for Bubble-style switches and compound controls. Compose safe containers and controls instead of flattening the design into unrelated blocks.",
        "For lights, include only capability-advertised controls: toggle power, brightness_pct slider, Kelvin slider, RGB color_picker, and effect select. Use advertised ranges/options and local value expressions in actions.",
        "Use vector_icon for custom decorative or semantic symbols; only safe declarative path/circle/ellipse/rect/line/polyline/group shapes, gradients, focal points, numeric coordinate_mode, ordered transform stacks, blend modes, safe filter presets, glow/neon/blur/color effects, and preset or keyframe shape animations are allowed.",
        "Use visual_map for relationship or flow cards. AI owns node positions, node sizes, labels, icons, link routing style, and animation choices; UrDash only renders the safe declarative map.",
        "Define reusable MDI or declarative vector variants in card.assets.icon_sets when several blocks share a visual language. Reference them with icon_ref set and a literal or expression key instead of duplicating artwork.",
        "For visual_map, use stats on nodes when a node needs multiple readings, shape ring for dashboard-style circular meters, anchors and path.points for precise routing, and flow_dot for visible movement along a link.",
        "Use ambient as non-interactive visual depth behind useful controls; do not make decoration the only content.",
        "For climate requests, compose capability-driven component_tree controls for HVAC mode, one or two target temperatures, humidity, fan, preset, vertical swing, and horizontal swing. Use climate_control only as a compact convenience macro.",
        "For fan requests, compose capability-driven component_tree controls for power, percentage, presets, oscillation, and direction, but only when each operation appears in the entity capability descriptor.",
        "For cover requests, compose capability-driven component_tree controls for movement, position, tilt movement, and tilt position, but only when each operation appears in the entity capability descriptor.",
        "For media-player requests, compose capability-driven component_tree metadata, transport, volume, mute, seek, source, sound mode, shuffle, and repeat controls. Bind seek maximum to media_duration and omit browse/play-media operations.",
        "For security requests, compose capability-driven alarm, lock, and siren controls, clearly separate risky actions, never embed credentials, and use more_info for operations marked requires_user_code.",
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
