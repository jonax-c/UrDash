from __future__ import annotations

import asyncio
import json
from typing import Any

import yaml

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL
from .dashboard_context import CUSTOM_CARDS

SYSTEM_PROMPT = """You are UrDash, a Home Assistant dashboard designer.
Create dashboards that are beautiful, usable, fast to scan, and practical for daily home control.
Return only structured JSON matching the requested schema.
Prefer installed or allowed custom cards when useful, but keep the YAML valid Lovelace.
Do not invent entity IDs. Use only entity IDs from the provided entity list.
If asked for a new view, generate a single new Lovelace view/tab that can be appended to an existing dashboard.
If asked for a custom card, do not return ordinary Lovelace cards. Design a native UrDash card spec instead.
Never modify, remove, or rewrite the reference dashboard.
"""

DASHBOARD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["yaml", "summary", "notes"],
    "properties": {
        "yaml": {"type": "string"},
        "summary": {"type": "string"},
        "notes": {"type": "array", "items": {"type": "string"}},
    },
}

CUSTOM_CARD_SPEC_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["title", "subtitle", "theme", "sections"],
    "properties": {
        "title": {"type": "string"},
        "subtitle": {"type": "string"},
        "theme": {
            "type": "string",
            "enum": ["aurora", "calm", "graphite", "sunrise", "quiet"],
        },
        "sections": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["title", "subtitle", "layout", "cards"],
                "properties": {
                    "title": {"type": "string"},
                    "subtitle": {"type": "string"},
                    "layout": {
                        "type": "string",
                        "enum": ["feature", "grid", "dense"],
                    },
                    "cards": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": [
                                "type",
                                "title",
                                "subtitle",
                                "icon",
                                "accent",
                                "entity_ids",
                            ],
                            "properties": {
                                "type": {
                                    "type": "string",
                                    "enum": [
                                        "hero",
                                        "orbit",
                                        "scene",
                                        "metric",
                                        "control",
                                        "timeline",
                                        "status",
                                        "list",
                                    ],
                                },
                                "title": {"type": "string"},
                                "subtitle": {"type": "string"},
                                "icon": {"type": "string"},
                                "accent": {"type": "string"},
                                "entity_ids": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                },
                            },
                        },
                    },
                },
            },
        },
    },
}

CUSTOM_CARD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["card", "summary", "notes"],
    "properties": {
        "card": CUSTOM_CARD_SPEC_SCHEMA,
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
    style: str,
    allow_custom_cards: bool,
    mode: str = "dashboard",
    reference_dashboard: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Generate a dashboard with the OpenAI Responses API."""
    if not api_key:
        raise AiGenerationError("OpenAI API key is not configured.")

    payload = {
        "model": model or DEFAULT_OPENAI_MODEL,
        "input": [
            {
                "role": "system",
                "content": [{"type": "input_text", "text": SYSTEM_PROMPT}],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": json.dumps(
                            {
                                "request": request,
                                "style": style,
                                "mode": mode,
                                "allow_custom_cards": allow_custom_cards,
                                "available_custom_cards": CUSTOM_CARDS if allow_custom_cards else [],
                                "entities": _compact_entities(entities),
                                "reference_dashboard": _compact_dashboard(reference_dashboard),
                                "requirements": _requirements_for_mode(mode),
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
                "name": "urdash_dashboard",
                "schema": _schema_for_mode(mode),
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
        generated = json.loads(output_text)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as err:
        raise AiGenerationError("AI provider returned an unexpected response.") from err

    if mode in {"custom_card", "custom_dashboard"}:
        custom_card = generated.get("card")
        if not isinstance(custom_card, dict):
            raise AiGenerationError("AI provider returned an invalid custom card.")
        if not isinstance(custom_card.get("sections"), list):
            raise AiGenerationError("AI provider returned a custom card without sections.")
        card_yaml = yaml.safe_dump(
            {
                "type": "custom:urdash-card",
                "height_mode": "auto",
                "dashboard": custom_card,
            },
            allow_unicode=True,
            sort_keys=False,
        ).strip()
        return {
            "custom_card": custom_card,
            "custom_dashboard": custom_card,
            "yaml": card_yaml,
            "json": json.dumps(custom_card, ensure_ascii=False, indent=2),
            "dependencies": [],
            "summary": generated.get("summary", "Generated with AI."),
            "notes": generated.get("notes", []),
            "engine": "ai",
            "mode": mode,
            "model": model or DEFAULT_OPENAI_MODEL,
        }

    yaml_value = generated["yaml"].strip()
    try:
        parsed_yaml = yaml.safe_load(yaml_value)
    except yaml.YAMLError as err:
        raise AiGenerationError("AI provider returned invalid YAML.") from err

    if not isinstance(parsed_yaml, dict):
        raise AiGenerationError("AI provider returned YAML that is not a Lovelace object.")

    if mode == "new_view":
        view = parsed_yaml
        if "views" in view or "title" in view and isinstance(view.get("views"), list):
            raise AiGenerationError("AI provider returned a full dashboard instead of a single view.")
        if "type" not in view and "cards" not in view and "sections" not in view:
            raise AiGenerationError("AI provider returned YAML that does not look like a Lovelace view.")
        dashboard = {"title": "UrDash", "views": [view]}
    else:
        view = None
        dashboard = parsed_yaml
        if "views" not in dashboard:
            raise AiGenerationError("AI provider returned a dashboard without views.")

    return {
        "dashboard": dashboard,
        "yaml": yaml_value,
        "dependencies": [
            {
                **card,
                "required": card["id"] in {"mushroom", "mini-graph-card"},
                "installed": False,
                "checked": False,
            }
            for card in CUSTOM_CARDS
        ]
        if allow_custom_cards
        else [],
        "summary": generated.get("summary", "Generated with AI."),
        "notes": generated.get("notes", []),
        "engine": "ai",
        "mode": mode,
        "model": model or DEFAULT_OPENAI_MODEL,
        **({"view": view} if view is not None else {}),
    }


def _extract_output_text(response_json: dict[str, Any]) -> str:
    if isinstance(response_json.get("output_text"), str):
        return response_json["output_text"]

    for item in response_json.get("output", []):
        for content in item.get("content", []):
            if content.get("type") in {"output_text", "text"} and isinstance(content.get("text"), str):
                return content["text"]

    raise KeyError("output_text")


def _schema_for_mode(mode: str) -> dict[str, Any]:
    if mode in {"custom_card", "custom_dashboard"}:
        return CUSTOM_CARD_SCHEMA
    return DASHBOARD_SCHEMA


def _requirements_for_mode(mode: str) -> list[str]:
    if mode in {"custom_card", "custom_dashboard"}:
        return [
            "Return a native UrDash custom card object in the card field.",
            "Do not return ordinary Lovelace YAML.",
            "Use only entity IDs from the provided entity list.",
            "Design one embeddable Lovelace custom card that can solve the user's requested card use case.",
            "Support many card intents: sensor summaries, weather cards, room control cards, security panels, energy cards, climate cards, and scene launchers.",
            "Do not design a traditional rectangular Lovelace-style card unless the user explicitly asks for plain utility.",
            "Use sections as zones inside the card experience, not as full dashboard rows.",
            "Prefer card types hero, orbit, scene, metric, control, and timeline for a more custom visual experience.",
            "Use theme quiet when the user asks for minimalist, calm, subtle, or low-distraction UI.",
            "For theme quiet, design an understated card with sparse strips, a focused central signal, command rows, and a thin timeline.",
            "Use status and list only when they improve scanning.",
            "Keep entity_ids arrays focused; do not overload one card with too many unrelated entities.",
            "Use accent values as CSS color strings such as #1f8a70.",
        ]
    return [
        "Return Lovelace YAML in the yaml field.",
        "The yaml field must contain valid YAML only, without Markdown fences.",
        "Use sections view when it improves usability.",
        "Group controls by purpose and room.",
        "Make the first view immediately useful on phone and desktop.",
        "Prefer built-in tile/entities/grid cards when custom cards are disabled.",
        "For mode new_view, return exactly one Lovelace view object as YAML.",
        "For mode new_view, use the reference dashboard only for style and context.",
        "For mode new_view, do not include title/views wrapping or existing views.",
        "For mode dashboard, return a complete Lovelace dashboard YAML object with title and views.",
    ]


def _compact_entities(entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    compact = []
    for entity in entities[:250]:
        attributes = entity.get("attributes") or {}
        compact.append(
            {
                "entity_id": entity.get("entity_id"),
                "state": entity.get("state"),
                "name": attributes.get("friendly_name"),
                "device_class": attributes.get("device_class"),
                "unit": attributes.get("unit_of_measurement"),
            }
        )
    return compact


def _compact_dashboard(reference_dashboard: dict[str, Any] | None) -> dict[str, Any] | None:
    if not reference_dashboard:
        return None

    views = []
    for view in reference_dashboard.get("views", [])[:12]:
        if not isinstance(view, dict):
            continue
        views.append(
            {
                "title": view.get("title"),
                "path": view.get("path"),
                "icon": view.get("icon"),
                "type": view.get("type"),
                "card_count": _count_cards(view),
            }
        )

    return {
        "title": reference_dashboard.get("title"),
        "views": views,
    }


def _count_cards(value: Any) -> int:
    if isinstance(value, dict):
        count = 1 if "type" in value else 0
        return count + sum(_count_cards(child) for child in value.values())
    if isinstance(value, list):
        return sum(_count_cards(child) for child in value)
    return 0
