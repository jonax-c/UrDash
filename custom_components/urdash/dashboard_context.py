from __future__ import annotations

from typing import Any

CUSTOM_CARDS = [
    {
        "id": "mushroom",
        "name": "Mushroom Cards",
        "resource": "/hacsfiles/lovelace-mushroom/mushroom.js",
        "hacs_url": "https://my.home-assistant.io/redirect/hacs_repository/?owner=piitaya&repository=lovelace-mushroom&category=plugin",
        "used_for": "Beautiful entity, light, climate, cover, and chip controls",
    },
    {
        "id": "bubble-card",
        "name": "Bubble Card",
        "resource": "/hacsfiles/Bubble-Card/bubble-card.js",
        "hacs_url": "https://my.home-assistant.io/redirect/hacs_repository/?owner=Clooos&repository=Bubble-Card&category=plugin",
        "used_for": "Room pop-ups and compact high-polish controls",
    },
    {
        "id": "button-card",
        "name": "button-card",
        "resource": "/hacsfiles/button-card/button-card.js",
        "hacs_url": "https://my.home-assistant.io/redirect/hacs_repository/?owner=custom-cards&repository=button-card&category=plugin",
        "used_for": "Custom action tiles and expressive status buttons",
    },
    {
        "id": "mini-graph-card",
        "name": "mini-graph-card",
        "resource": "/hacsfiles/mini-graph-card/mini-graph-card-bundle.js",
        "hacs_url": "https://my.home-assistant.io/redirect/hacs_repository/?owner=kalkih&repository=mini-graph-card&category=plugin",
        "used_for": "Clean sensor trends and history cards",
    },
    {
        "id": "card-mod",
        "name": "card-mod",
        "resource": "/hacsfiles/lovelace-card-mod/card-mod.js",
        "hacs_url": "https://my.home-assistant.io/redirect/hacs_repository/?owner=thomasloven&repository=lovelace-card-mod&category=plugin",
        "used_for": "Fine-grained spacing, color, and border styling",
    },
]


def serialize_state(state: Any) -> dict[str, Any]:
    """Convert a Home Assistant State object into panel-friendly data."""
    return {
        "entity_id": state.entity_id,
        "state": state.state,
        "attributes": dict(state.attributes),
    }
