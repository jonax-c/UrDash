from __future__ import annotations

import asyncio
import json
from typing import Any

import yaml

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL

SYSTEM_PROMPT = """You are UrDash v2, a Home Assistant custom-card designer.
Create one safe, declarative UrDash card spec for a Lovelace custom card.
Return only structured JSON matching the requested schema.
Do not generate JavaScript, HTML, CSS, markdown, or ordinary Lovelace cards.
Use only entity IDs from the provided entity list.
Design the card before composing blocks: choose the user's task, visible state, one-tap actions, secondary context, risky actions, and a layout that makes the card useful.
Cards may combine multiple device functions when it helps the user's goal.
Design expressive card experiences, not just block grids. Use canvas layout, floating primitives, hero values, ambient layers, orbit/constellation compositions, strips, and unframed surfaces when they improve the card.
Prefer direct, usable controls over decorative blocks, but make the interface visually distinctive.
Use declarative animation presets only when they improve clarity.
"""

ACTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["type"],
    "properties": {
        "type": {"type": "string", "enum": ["service", "more_info", "navigate", "none"]},
        "domain": {
            "type": "string",
            "enum": ["light", "switch", "fan", "climate", "cover", "lock", "scene", "script", "media_player"],
        },
        "service": {
            "type": "string",
            "enum": [
                "turn_on",
                "turn_off",
                "toggle",
                "set_temperature",
                "set_hvac_mode",
                "open_cover",
                "close_cover",
                "stop_cover",
                "lock",
                "unlock",
                "media_play_pause",
                "volume_set",
            ],
        },
        "entity_id": {"type": "string"},
        "navigation_path": {"type": "string"},
        "data": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "temperature": {"type": ["number", "string"]},
                "hvac_mode": {"type": "string"},
                "brightness": {"type": ["number", "string"]},
                "brightness_pct": {"type": ["number", "string"]},
                "position": {"type": ["number", "string"]},
                "volume_level": {"type": ["number", "string"]},
            },
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

STYLE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "tone": {"type": "string", "enum": ["neutral", "calm", "warm", "cool", "alert", "success"]},
        "emphasis": {"type": "string", "enum": ["low", "normal", "high", "hero"]},
        "shape": {"type": "string", "enum": ["none", "soft", "pill", "circle"]},
        "density": {"type": "string", "enum": ["compact", "comfortable", "spacious"]},
        "accent": {"type": "string"},
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
        "scale": {"type": "string", "enum": ["micro", "small", "normal", "large", "xl"]},
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
            ],
        },
        "title": {"type": "string"},
        "subtitle": {"type": "string"},
        "text": {"type": "string"},
        "variant": {"type": "string", "enum": ["label", "body", "headline", "title", "caption"]},
        "label": {"type": "string"},
        "icon": {"type": "string"},
        "entity": {"type": "string"},
        "entities": {"type": "array", "items": {"type": "string"}},
        "bind": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "value": {"type": "string"},
                "label": {"type": "string"},
                "unit": {"type": "string"},
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
        "frame": {
            "type": "object",
            "additionalProperties": False,
            "required": ["x", "y", "w", "h"],
            "properties": {
                "x": {"type": "number"},
                "y": {"type": "number"},
                "w": {"type": "number"},
                "h": {"type": "number"},
            },
        },
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["entity", "label", "value"],
                "properties": {
                    "entity": {"type": "string"},
                    "label": {"type": "string"},
                    "value": {"type": "string"},
                    "unit": {"type": "string"},
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
                    "label": {"type": "string"},
                    "icon": {"type": "string"},
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
                    "label": {"type": "string"},
                    "entity": {"type": "string"},
                    "icon": {"type": "string"},
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
        "style": STYLE_SCHEMA,
        "presentation": PRESENTATION_SCHEMA,
        "animation": ANIMATION_SCHEMA,
        "visibility": {
            "type": "object",
            "additionalProperties": False,
            "required": ["entity", "operator"],
            "properties": {
                "entity": {"type": "string"},
                "operator": {"type": "string", "enum": ["equals", "not_equals", "in", "not_in", "exists"]},
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
    "type": "object",
    "additionalProperties": False,
    "required": ["type", "urdash_schema", "height_mode", "card"],
    "properties": {
        "type": {"type": "string", "enum": ["custom:urdash-card"]},
        "urdash_schema": {"type": "integer", "enum": [2]},
        "height_mode": {"type": "string", "enum": ["auto", "viewport", "fixed"]},
        "height": {"type": "integer", "minimum": 240, "maximum": 1200},
        "card": {
            "type": "object",
            "additionalProperties": False,
            "required": ["intent", "layout"],
            "properties": {
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
                        "columns": {"type": "integer", "minimum": 4, "maximum": 16},
                        "density": {"type": "string", "enum": ["compact", "comfortable", "spacious"]},
                        "theme": {"type": "string", "enum": ["aurora", "quiet", "graphite", "calm", "sunrise"]},
                        "aspect_ratio": {"type": "string"},
                        "blocks": {"type": "array", "items": BLOCK_SCHEMA},
                    },
                },
            },
        },
    },
}

GENERATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["card_config", "summary", "notes"],
    "properties": {
        "card_config": CARD_V2_SCHEMA,
        "summary": {"type": "string"},
        "notes": {"type": "array", "items": {"type": "string"}},
    },
}


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
    theme: str,
    height_mode: str,
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
                                "entities": _compact_entities(entities),
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
                "schema": GENERATION_SCHEMA,
                "strict": False,
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
        generated = json.loads(output_text)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as err:
        raise AiGenerationError("AI provider returned an unexpected response.") from err

    card_config = generated.get("card_config")
    if not isinstance(card_config, dict) or card_config.get("urdash_schema") != 2:
        raise AiGenerationError("AI provider returned an invalid UrDash v2 card.")

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
        "Use hero_value, ambient, entity_orbit, constellation, and radial_scene for expressive visual structure when appropriate.",
        "Use ambient as non-interactive visual depth behind useful controls; do not make decoration the only content.",
        "For climate requests, include climate_control and useful mode/temperature controls.",
        "For room requests, combine controllable devices and key sensors in one card when helpful.",
        "For security requests, make attention states visible and require confirmation for risky actions.",
        "For sensor requests, make the primary value readable and include supporting context.",
        "Use button, button_group, segmented_control, slider, climate_control, cover_control, scene_strip, toggle_group, value, value_cluster, timeline, chip_group, hero_value, entity_orbit, constellation, radial_scene, or ambient as needed.",
        "Keep blocks focused. Prefer 4 to 12 blocks unless the user requests a dense card.",
        "Do not invent entity IDs.",
        "Use declarative animation presets only; no CSS, HTML, or JavaScript.",
    ]


def _compact_entities(entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    compact = []
    for entity in entities[:250]:
        attributes = entity.get("attributes") or {}
        compact.append(
            {
                "entity_id": entity.get("entity_id"),
                "state": entity.get("state"),
                "name": entity.get("name") or attributes.get("friendly_name"),
                "domain": entity.get("domain") or str(entity.get("entity_id", "")).split(".", 1)[0],
                "area": entity.get("area_name"),
                "device": entity.get("device_name"),
                "device_class": attributes.get("device_class"),
                "unit": attributes.get("unit_of_measurement"),
                "current_temperature": attributes.get("current_temperature"),
                "target_temperature": attributes.get("temperature"),
                "hvac_modes": attributes.get("hvac_modes"),
            }
        )
    return compact


def _extract_output_text(response_json: dict[str, Any]) -> str:
    if isinstance(response_json.get("output_text"), str):
        return response_json["output_text"]

    for item in response_json.get("output", []):
        for content in item.get("content", []):
            if content.get("type") in {"output_text", "text"} and isinstance(content.get("text"), str):
                return content["text"]

    raise KeyError("output_text")
