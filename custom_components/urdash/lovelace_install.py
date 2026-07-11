from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from typing import Any


def config_revision(config: dict[str, Any]) -> str:
    """Return a stable revision for conflict detection."""
    encoded = json.dumps(config, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()[:24]


def _view_visible_to_user(view: dict[str, Any], user_id: str | None) -> bool:
    visibility = view.get("visible", True)
    if visibility is False:
        return False
    if not isinstance(visibility, list) or user_id is None:
        return True
    allowed_users = {
        condition.get("user")
        for condition in visibility
        if isinstance(condition, dict) and condition.get("user")
    }
    return not allowed_users or user_id in allowed_users


def visible_views(config: dict[str, Any], user_id: str | None = None) -> list[dict[str, Any]]:
    """Return top-level visible Lovelace views that can accept a card."""
    result = []
    for index, view in enumerate(config.get("views", [])):
        if not isinstance(view, dict):
            continue
        if not _view_visible_to_user(view, user_id) or view.get("subview") is True:
            continue
        path = view.get("path")
        result.append(
            {
                "id": f"path:{path}" if path else f"index:{index}",
                "index": index,
                "path": path,
                "title": view.get("title") or path or f"View {index + 1}",
            }
        )
    return result


def sanitize_card_config(card_config: dict[str, Any]) -> dict[str, Any]:
    """Remove generation-console-only values before installation."""
    sanitized = deepcopy(card_config)
    sanitized.pop("preview", None)
    sanitized.pop("preview_mode", None)
    return sanitized


def append_card(
    config: dict[str, Any],
    view_id: str,
    card_config: dict[str, Any],
    user_id: str | None = None,
) -> dict[str, Any]:
    """Return a new config with one card appended to the selected visible view."""
    updated = deepcopy(config)
    views = updated.get("views")
    if not isinstance(views, list):
        raise ValueError("Dashboard does not contain editable views.")

    target_index: int | None = None
    if view_id.startswith("path:"):
        path = view_id.removeprefix("path:")
        target_index = next(
            (
                index
                for index, view in enumerate(views)
                if isinstance(view, dict) and view.get("path") == path
            ),
            None,
        )
    elif view_id.startswith("index:"):
        try:
            target_index = int(view_id.removeprefix("index:"))
        except ValueError as err:
            raise ValueError("Invalid Lovelace view target.") from err

    if target_index is None or not 0 <= target_index < len(views):
        raise ValueError("The selected Lovelace view no longer exists.")

    view = views[target_index]
    if (
        not isinstance(view, dict)
        or not _view_visible_to_user(view, user_id)
        or view.get("subview") is True
    ):
        raise ValueError("The selected Lovelace view is not a visible tab.")
    cards = view.setdefault("cards", [])
    if not isinstance(cards, list):
        raise ValueError("The selected Lovelace view does not contain an editable card list.")
    cards.append(sanitize_card_config(card_config))
    return updated
