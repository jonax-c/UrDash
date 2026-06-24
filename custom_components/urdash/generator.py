from __future__ import annotations

from collections import defaultdict
from typing import Any

import yaml

CUSTOM_CARDS = [
    {
        "id": "mushroom",
        "name": "Mushroom Cards",
        "resource": "/hacsfiles/lovelace-mushroom/mushroom.js",
        "used_for": "Beautiful entity, light, climate, cover, and chip controls",
    },
    {
        "id": "bubble-card",
        "name": "Bubble Card",
        "resource": "/hacsfiles/Bubble-Card/bubble-card.js",
        "used_for": "Room pop-ups and compact high-polish controls",
    },
    {
        "id": "button-card",
        "name": "button-card",
        "resource": "/hacsfiles/button-card/button-card.js",
        "used_for": "Custom action tiles and expressive status buttons",
    },
    {
        "id": "mini-graph-card",
        "name": "mini-graph-card",
        "resource": "/hacsfiles/mini-graph-card/mini-graph-card-bundle.js",
        "used_for": "Clean sensor trends and history cards",
    },
    {
        "id": "card-mod",
        "name": "card-mod",
        "resource": "/hacsfiles/lovelace-card-mod/card-mod.js",
        "used_for": "Fine-grained spacing, color, and border styling",
    },
]

CONTROL_DOMAINS = ["light", "switch", "lock", "cover", "climate", "media_player"]
PRIORITY_DOMAINS = [*CONTROL_DOMAINS, "sensor", "binary_sensor"]
AREAS = [
    "living room",
    "kitchen",
    "bedroom",
    "bathroom",
    "office",
    "garage",
    "garden",
    "hallway",
    "laundry",
    "dining room",
]


def serialize_state(state: Any) -> dict[str, Any]:
    """Convert a Home Assistant State object into panel-friendly data."""
    return {
        "entity_id": state.entity_id,
        "state": state.state,
        "attributes": dict(state.attributes),
    }


def build_dashboard(
    request: str,
    entities: list[dict[str, Any]],
    style: str,
    allow_custom_cards: bool,
) -> dict[str, Any]:
    """Build a Lovelace dashboard from a request and Home Assistant entities."""
    selected = sorted(
        [entity for entity in entities if entity.get("entity_id")],
        key=lambda entity: score_entity(entity, request),
        reverse=True,
    )

    dashboard = {
        "title": "UrDash",
        "views": [
            {
                "title": "Home",
                "path": "home",
                "icon": "mdi:home-heart",
                "type": "sections",
                "max_columns": max_columns_for_style(style),
                "sections": [
                    {
                        "type": "grid",
                        "cards": pick_cards(selected, request, allow_custom_cards),
                    }
                ],
                "badges": [],
            }
        ],
    }

    dependencies = [
        {
            **card,
            "required": card["id"] in {"mushroom", "mini-graph-card"},
            "installed": False,
            "checked": False,
        }
        for card in CUSTOM_CARDS
    ]
    if not allow_custom_cards:
        dependencies = []

    return {
        "dashboard": dashboard,
        "yaml": yaml.safe_dump(
            dashboard,
            sort_keys=False,
            allow_unicode=False,
            width=120,
        ),
        "dependencies": dependencies,
        "summary": (
            f"Generated a {style} dashboard using {len(selected)} entities and "
            f"{len(dependencies)} custom-card recommendations."
        ),
    }


def build_new_view(
    request: str,
    entities: list[dict[str, Any]],
    style: str,
    allow_custom_cards: bool,
    reference_dashboard: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a new Lovelace view intended to be appended as a new dashboard tab."""
    dashboard_result = build_dashboard(request, entities, style, allow_custom_cards)
    view = dashboard_result["dashboard"]["views"][0]
    view["title"] = _new_view_title(request, reference_dashboard)
    view["path"] = _unique_view_path(view["title"], reference_dashboard)

    dependencies = dashboard_result["dependencies"]
    return {
        "dashboard": {
            "title": reference_dashboard.get("title", "UrDash") if reference_dashboard else "UrDash",
            "views": [view],
        },
        "view": view,
        "yaml": yaml.safe_dump(
            view,
            sort_keys=False,
            allow_unicode=False,
            width=120,
        ),
        "dependencies": dependencies,
        "summary": (
            f"Generated a new {style} Lovelace tab. Paste this YAML as a new view; "
            "the reference dashboard is not modified."
        ),
        "mode": "new_view",
    }


def _new_view_title(request: str, reference_dashboard: dict[str, Any] | None) -> str:
    existing_count = len((reference_dashboard or {}).get("views", []))
    if "energy" in request.lower():
        return "Energy"
    if "security" in request.lower() or "door" in request.lower():
        return "Security"
    if "climate" in request.lower():
        return "Climate"
    if "room" in request.lower():
        return "Rooms"
    return f"UrDash {existing_count + 1}"


def _unique_view_path(title: str, reference_dashboard: dict[str, Any] | None) -> str:
    base = "-".join(title.lower().split()) or "urdash"
    existing_paths = {
        view.get("path")
        for view in (reference_dashboard or {}).get("views", [])
        if isinstance(view, dict)
    }
    if base not in existing_paths:
        return base

    suffix = 2
    while f"{base}-{suffix}" in existing_paths:
        suffix += 1
    return f"{base}-{suffix}"


def max_columns_for_style(style: str) -> int:
    if style == "minimal":
        return 2
    if style == "compact":
        return 3
    return 4


def pick_cards(
    entities: list[dict[str, Any]],
    request: str,
    allow_custom_cards: bool,
) -> list[dict[str, Any]]:
    sorted_entities = sorted(
        entities,
        key=lambda entity: score_entity(entity, request),
        reverse=True,
    )
    by_domain = group_by_domain(sorted_entities)
    cards: list[dict[str, Any]] = []

    controls = [
        entity
        for domain in CONTROL_DOMAINS
        for entity in by_domain.get(domain, [])
    ][:12]
    if controls:
        cards.append(title_card("Everyday Controls", "The devices people reach for most often.", allow_custom_cards))
        cards.append(
            {
                "type": "grid",
                "columns": 2,
                "square": False,
                "cards": [control_card(entity, allow_custom_cards) for entity in controls],
            }
        )

    sensors = [*by_domain.get("sensor", []), *by_domain.get("binary_sensor", [])][:8]
    if sensors:
        cards.append(title_card("Home Pulse", "Useful readings and trends at a glance.", allow_custom_cards))
        cards.append(
            {
                "type": "grid",
                "columns": 2,
                "square": False,
                "cards": [sensor_card(entity, allow_custom_cards) for entity in sensors],
            }
        )

    for room in group_by_area(sorted_entities)[:5]:
        cards.append(
            title_card(
                title_case(room["area"]),
                f"{len(room['entities'])} connected entities",
                allow_custom_cards,
            )
        )
        cards.append(
            {
                "type": "entities",
                "entities": [
                    entity["entity_id"]
                    for entity in room["entities"][:8]
                ],
            }
        )

    return cards


def title_card(title: str, subtitle: str, allow_custom_cards: bool) -> dict[str, Any]:
    if allow_custom_cards:
        return {
            "type": "custom:mushroom-title-card",
            "title": title,
            "subtitle": subtitle,
        }
    return {"type": "heading", "heading": title, "title": title}


def control_card(entity: dict[str, Any], allow_custom_cards: bool) -> dict[str, Any]:
    entity_id = entity["entity_id"]
    domain = domain_of(entity)

    if not allow_custom_cards:
        return {"type": "tile", "entity": entity_id}

    if domain == "light":
        return {
            "type": "custom:mushroom-light-card",
            "entity": entity_id,
            "show_brightness_control": True,
        }
    if domain == "climate":
        return {
            "type": "custom:mushroom-climate-card",
            "entity": entity_id,
            "show_temperature_control": True,
        }
    if domain == "cover":
        return {
            "type": "custom:mushroom-cover-card",
            "entity": entity_id,
            "show_buttons_control": True,
        }
    if domain == "lock":
        return {"type": "custom:mushroom-lock-card", "entity": entity_id}
    if domain == "media_player":
        return {
            "type": "custom:mushroom-media-player-card",
            "entity": entity_id,
            "use_media_info": True,
        }
    return {"type": "custom:mushroom-entity-card", "entity": entity_id}


def sensor_card(entity: dict[str, Any], allow_custom_cards: bool) -> dict[str, Any]:
    entity_id = entity["entity_id"]
    if allow_custom_cards and domain_of(entity) == "sensor":
        return {
            "type": "custom:mini-graph-card",
            "entities": [entity_id],
            "name": entity_name(entity),
            "hours_to_show": 24,
            "points_per_hour": 2,
            "line_width": 3,
            "animate": True,
        }
    return {"type": "tile", "entity": entity_id}


def group_by_domain(entities: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entity in entities:
        grouped[domain_of(entity)].append(entity)
    return grouped


def group_by_area(entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entity in entities:
        grouped[area_guess(entity)].append(entity)
    return [{"area": area, "entities": grouped_entities} for area, grouped_entities in grouped.items()]


def score_entity(entity: dict[str, Any], request: str) -> int:
    haystack = f"{entity.get('entity_id', '')} {entity_name(entity)} {domain_of(entity)}".lower()
    score = 0

    for word in request.lower().split():
        if word.strip(".,:;!?") in haystack:
            score += 2

    if domain_of(entity) in PRIORITY_DOMAINS:
        score += 1

    if entity.get("state") not in {None, "unknown", "unavailable"}:
        score += 1

    return score


def entity_name(entity: dict[str, Any]) -> str:
    attributes = entity.get("attributes") or {}
    return attributes.get("friendly_name") or entity.get("entity_id", "").split(".")[-1].replace("_", " ")


def area_guess(entity: dict[str, Any]) -> str:
    text = f"{entity.get('entity_id', '')} {entity_name(entity)}".lower()
    return next((area for area in AREAS if area in text), "home")


def domain_of(entity: dict[str, Any]) -> str:
    return entity.get("entity_id", "").split(".", 1)[0]


def title_case(text: str) -> str:
    return " ".join(word.capitalize() for word in text.split())
