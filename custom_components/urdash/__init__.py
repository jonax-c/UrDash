from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
from typing import Any

import voluptuous as vol
import yaml

from homeassistant.components import frontend, websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

try:
    from homeassistant.components.http import StaticPathConfig
except ImportError:
    StaticPathConfig = None

from .const import (
    CONF_ALLOW_CUSTOM_CARDS,
    CONF_API_KEY,
    CONF_BASE_URL,
    CONF_DEFAULT_STYLE,
    CONF_MODEL,
    DEFAULT_ALLOW_CUSTOM_CARDS,
    DEFAULT_OPENAI_BASE_URL,
    DEFAULT_OPENAI_MODEL,
    DEFAULT_STYLE,
    DOMAIN,
    FRONTEND_DIR,
    FRONTEND_JS,
    FRONTEND_VERSION,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL,
    STATIC_URL,
)
from .ai_client import AiGenerationError, async_generate_with_openai
from .dashboard_context import CUSTOM_CARDS, serialize_state

PLATFORMS: list[str] = []

SERVICE_GENERATE_DASHBOARD = "generate_dashboard"

GENERATE_SERVICE_SCHEMA = vol.Schema(
    {
        vol.Required("request"): cv.string,
        vol.Optional("style", default=DEFAULT_STYLE): vol.In(
            ["modern", "minimal", "glass", "compact"]
        ),
        vol.Optional(
            "allow_custom_cards", default=DEFAULT_ALLOW_CUSTOM_CARDS
        ): cv.boolean,
        vol.Optional("mode", default="dashboard"): vol.In(["dashboard", "new_view"]),
        vol.Optional("reference_dashboard", default=""): cv.string,
        vol.Optional("entity_ids"): vol.All(cv.ensure_list, [cv.entity_id]),
    }
)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up UrDash from a config entry."""
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = entry.data

    await _async_register_static_path(hass)
    _register_panel(hass)
    _register_websocket_commands(hass)
    _register_services(hass)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload UrDash."""
    hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    frontend.async_remove_panel(hass, PANEL_URL)
    return True


async def _async_register_static_path(hass: HomeAssistant) -> None:
    static_path = Path(__file__).parent / FRONTEND_DIR
    if StaticPathConfig is not None and hasattr(hass.http, "async_register_static_paths"):
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(
                    url_path=STATIC_URL,
                    path=str(static_path),
                    cache_headers=True,
                )
            ]
        )
        return

    await hass.http.async_register_static_path(
        STATIC_URL,
        str(static_path),
        True,
    )


def _register_panel(hass: HomeAssistant) -> None:
    frontend.async_register_built_in_panel(
        hass,
        component_name="custom",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        frontend_url_path=PANEL_URL,
        require_admin=False,
        config={
            "_panel_custom": {
                "name": "urdash-panel",
                "js_url": f"{STATIC_URL}/{FRONTEND_JS}?v={FRONTEND_VERSION}",
                "embed_iframe": False,
                "trust_external_script": False,
            }
        },
    )


def _register_websocket_commands(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, websocket_entities)
    websocket_api.async_register_command(hass, websocket_resources)
    websocket_api.async_register_command(hass, websocket_reference_views)
    websocket_api.async_register_command(hass, websocket_settings)
    websocket_api.async_register_command(hass, websocket_generate)
    websocket_api.async_register_command(hass, websocket_append_view)


def _register_services(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, SERVICE_GENERATE_DASHBOARD):
        return

    async def handle_generate(call: ServiceCall) -> None:
        result = await _async_generate_from_hass(
            hass,
            call.data["request"],
            call.data["style"],
            call.data["allow_custom_cards"],
            call.data["mode"],
            _parse_reference_dashboard(call.data.get("reference_dashboard")),
            call.data.get("entity_ids"),
        )
        hass.bus.async_fire(f"{DOMAIN}_dashboard_generated", result)

    hass.services.async_register(
        DOMAIN,
        SERVICE_GENERATE_DASHBOARD,
        handle_generate,
        schema=GENERATE_SERVICE_SCHEMA,
    )


@websocket_api.websocket_command({vol.Required("type"): "urdash/entities"})
@websocket_api.async_response
async def websocket_entities(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return current Home Assistant entities."""
    connection.send_result(
        msg["id"],
        {
            "entities": _serialize_states_with_registry(hass),
            "source": "home-assistant",
        },
    )


def _serialize_states_with_registry(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Return states enriched with entity/device/area registry metadata."""
    entity_registry = er.async_get(hass)
    device_registry = dr.async_get(hass)
    area_registry = ar.async_get(hass)
    serialized = []

    for state in hass.states.async_all():
        entity = serialize_state(state)
        entity_entry = entity_registry.async_get(state.entity_id)
        device = None
        area = None

        if entity_entry is not None:
            entity["name"] = (
                getattr(entity_entry, "name", None)
                or getattr(entity_entry, "original_name", None)
                or entity["attributes"].get("friendly_name")
            )
            entity["device_id"] = getattr(entity_entry, "device_id", None)
            entity["area_id"] = getattr(entity_entry, "area_id", None)
            if entity["device_id"]:
                device = device_registry.async_get(entity["device_id"])
        else:
            entity["name"] = entity["attributes"].get("friendly_name")
            entity["device_id"] = None
            entity["area_id"] = None

        if device is not None:
            entity["device_name"] = (
                getattr(device, "name_by_user", None)
                or getattr(device, "name", None)
                or getattr(device, "original_name", None)
            )
            entity["area_id"] = entity["area_id"] or getattr(device, "area_id", None)
        else:
            entity["device_name"] = None

        if entity["area_id"]:
            if hasattr(area_registry, "async_get_area"):
                area = area_registry.async_get_area(entity["area_id"])
            elif hasattr(area_registry, "async_get"):
                area = area_registry.async_get(entity["area_id"])
        entity["area_name"] = area.name if area is not None else None
        entity["domain"] = state.entity_id.split(".", 1)[0]
        serialized.append(entity)

    return serialized


@websocket_api.websocket_command({vol.Required("type"): "urdash/resources"})
@websocket_api.async_response
async def websocket_resources(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return recommended Lovelace card resources."""
    installed_urls = await _async_lovelace_resource_urls(hass)
    checked = installed_urls is not None
    installed_urls = installed_urls or set()

    resources = []
    for card in CUSTOM_CARDS:
        resources.append(
            {
                **card,
                "required": card["id"] in {"mushroom", "mini-graph-card"},
                "installed": _resource_installed(card["resource"], installed_urls),
                "checked": checked,
            }
        )
    connection.send_result(msg["id"], {"resources": resources})


@websocket_api.websocket_command({vol.Required("type"): "urdash/reference_views"})
@websocket_api.async_response
async def websocket_reference_views(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return existing UI-managed Lovelace views that can be used as reference."""
    views = await _async_reference_views(hass, connection.user.id)
    connection.send_result(msg["id"], {"views": views})


@websocket_api.websocket_command({vol.Required("type"): "urdash/settings"})
@websocket_api.async_response
async def websocket_settings(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return non-secret UrDash settings."""
    settings = _settings(hass)
    connection.send_result(
        msg["id"],
        {
            "ai_provider": "openai",
            "ai_enabled": bool(settings[CONF_API_KEY]),
            "model": settings[CONF_MODEL],
            "default_style": settings[CONF_DEFAULT_STYLE],
            "allow_custom_cards": settings[CONF_ALLOW_CUSTOM_CARDS],
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "urdash/generate",
        vol.Required("request"): cv.string,
        vol.Optional("style", default=DEFAULT_STYLE): vol.In(
            ["modern", "minimal", "glass", "compact"]
        ),
        vol.Optional(
            "allow_custom_cards", default=DEFAULT_ALLOW_CUSTOM_CARDS
        ): cv.boolean,
        vol.Optional("use_ai"): cv.boolean,
        vol.Optional("mode", default="dashboard"): vol.In(["dashboard", "new_view"]),
        vol.Optional("reference_dashboard"): dict,
        vol.Optional("reference_view_id"): str,
        vol.Optional("selected_entity_ids"): [cv.entity_id],
    }
)
@websocket_api.async_response
async def websocket_generate(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Generate Lovelace YAML."""
    result = await _async_generate_from_hass(
        hass,
        msg["request"],
        msg["style"],
        msg["allow_custom_cards"],
        msg["mode"],
        await _async_reference_dashboard_from_message(hass, msg),
        msg.get("selected_entity_ids"),
    )
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "urdash/append_view",
        vol.Required("view"): dict,
    }
)
@websocket_api.async_response
async def websocket_append_view(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Append a generated view to the default UI-managed Lovelace dashboard."""
    try:
        result = await _async_append_view_to_default_dashboard(hass, msg["view"])
    except ValueError as err:
        connection.send_result(msg["id"], {"ok": False, "error": str(err)})
        return

    connection.send_result(msg["id"], {"ok": True, **result})


async def _async_generate_from_hass(
    hass: HomeAssistant,
    request: str,
    style: str,
    allow_custom_cards: bool,
    mode: str = "dashboard",
    reference_dashboard: dict[str, Any] | None = None,
    selected_entity_ids: list[str] | None = None,
) -> dict[str, Any]:
    entities = [serialize_state(state) for state in hass.states.async_all()]
    if selected_entity_ids is not None:
        selected = set(selected_entity_ids)
        entities = [entity for entity in entities if entity["entity_id"] in selected]
    settings = _settings(hass)

    if not settings[CONF_API_KEY]:
        return {
            "error": "OpenAI API key is not configured.",
            "summary": "Configure an API key in UrDash integration options.",
            "engine": "ai",
            "mode": mode,
        }

    try:
        return await async_generate_with_openai(
            hass,
            api_key=settings[CONF_API_KEY],
            base_url=settings[CONF_BASE_URL],
            model=settings[CONF_MODEL],
            request=request,
            entities=entities,
            style=style,
            allow_custom_cards=allow_custom_cards,
            mode=mode,
            reference_dashboard=reference_dashboard,
        )
    except AiGenerationError as err:
        return {
            "error": str(err),
            "summary": "AI generation failed.",
            "engine": "ai",
            "mode": mode,
        }


def _settings(hass: HomeAssistant) -> dict[str, Any]:
    entries = hass.config_entries.async_entries(DOMAIN)
    data: dict[str, Any] = {}
    if entries:
        data.update(entries[0].data)
        data.update(entries[0].options)

    return {
        CONF_API_KEY: data.get(CONF_API_KEY, ""),
        CONF_MODEL: data.get(CONF_MODEL, DEFAULT_OPENAI_MODEL),
        CONF_BASE_URL: data.get(CONF_BASE_URL, DEFAULT_OPENAI_BASE_URL),
        CONF_DEFAULT_STYLE: data.get(CONF_DEFAULT_STYLE, DEFAULT_STYLE),
        CONF_ALLOW_CUSTOM_CARDS: data.get(CONF_ALLOW_CUSTOM_CARDS, DEFAULT_ALLOW_CUSTOM_CARDS),
    }


def _parse_reference_dashboard(value: str | None) -> dict[str, Any] | None:
    if not value:
        return None
    parsed = yaml.safe_load(value)
    return parsed if isinstance(parsed, dict) else None


def _normalize_reference_dashboard(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if not value:
        return None
    raw_yaml = value.get("raw_yaml")
    if isinstance(raw_yaml, str):
        return _parse_reference_dashboard(raw_yaml)
    return value


async def _async_lovelace_resource_urls(hass: HomeAssistant) -> set[str] | None:
    """Read configured Lovelace resources from HA storage when available."""
    storage_path = Path(hass.config.path(".storage/lovelace_resources"))
    if not storage_path.exists():
        return set()

    def read_storage() -> set[str] | None:
        try:
            payload = yaml.safe_load(storage_path.read_text(encoding="utf-8")) or {}
        except (OSError, yaml.YAMLError):
            return None

        data = payload.get("data") or {}
        items = data.get("items") or []
        urls = {
            item.get("url", "").split("?", 1)[0].rstrip("/")
            for item in items
            if isinstance(item, dict) and item.get("url")
        }
        return {url for url in urls if url}

    return await hass.async_add_executor_job(read_storage)


def _resource_installed(expected_url: str, installed_urls: set[str]) -> bool:
    expected = expected_url.split("?", 1)[0].rstrip("/")
    expected_tail = expected.removeprefix("/hacsfiles/")

    for installed in installed_urls:
        if installed == expected:
            return True
        if installed.endswith(expected):
            return True
        if expected_tail and expected_tail in installed:
            return True
    return False


async def _async_append_view_to_default_dashboard(
    hass: HomeAssistant,
    view: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(view, dict):
        raise ValueError("Generated view is invalid.")

    def append_view() -> dict[str, Any]:
        storage_path, payload, config = _find_lovelace_storage_target(hass)

        views = config.setdefault("views", [])
        if not isinstance(views, list):
            raise ValueError("Selected Lovelace dashboard views are not editable.")

        new_view = dict(view)
        new_view["title"] = str(new_view.get("title") or "UrDash")
        new_view["path"] = _unique_view_path(str(new_view.get("path") or new_view["title"]), views)

        backup_path = storage_path.with_name(
            f"{storage_path.name}.urdash-backup-{datetime.now().strftime('%Y%m%d%H%M%S')}"
        )
        backup_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        views.append(new_view)
        storage_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        return {
            "title": new_view["title"],
            "path": new_view["path"],
            "storage": storage_path.name,
            "backup": str(backup_path),
        }

    return await hass.async_add_executor_job(append_view)


def _find_lovelace_storage_target(
    hass: HomeAssistant,
) -> tuple[Path, dict[str, Any], dict[str, Any]]:
    dashboards = _editable_lovelace_storage_candidates(hass)
    if dashboards:
        return dashboards[0]

    storage_dir = Path(hass.config.path(".storage"))
    checked = [
        path.name
        for path in [storage_dir / "lovelace", *sorted(storage_dir.glob("lovelace.*"))]
        if path.exists() and path.name not in {"lovelace_resources", "lovelace_dashboards"}
    ]
    checked_text = ", ".join(checked) if checked else "none"
    raise ValueError(
        "No editable UI-managed Lovelace dashboard storage was found. "
        "This usually means the dashboard is YAML-mode, storage uses an unsupported format, "
        f"or no UI-managed dashboard has been created yet. Checked: {checked_text}."
    )


def _editable_lovelace_storage_candidates(
    hass: HomeAssistant,
) -> list[tuple[Path, dict[str, Any], dict[str, Any]]]:
    storage_dir = Path(hass.config.path(".storage"))
    candidates = [
        storage_dir / "lovelace",
        *sorted(storage_dir.glob("lovelace.*")),
    ]

    skipped_names = {"lovelace_resources", "lovelace_dashboards"}
    dashboards = []
    for storage_path in candidates:
        if not storage_path.exists() or storage_path.name in skipped_names:
            continue
        try:
            payload = json.loads(storage_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        config = (payload.get("data") or {}).get("config")
        if isinstance(config, dict) and isinstance(config.get("views"), list):
            dashboards.append((storage_path, payload, config))
    return dashboards


async def _async_reference_views(
    hass: HomeAssistant,
    user_id: str,
) -> list[dict[str, Any]]:
    def read_views() -> list[dict[str, Any]]:
        options = []
        for storage_path, _payload, config in _editable_lovelace_storage_candidates(hass):
            dashboard_title = str(config.get("title") or _dashboard_title_from_storage(storage_path))
            dashboard_url = _dashboard_url_for_storage(storage_path)
            for index, view in enumerate(config.get("views", [])):
                if not isinstance(view, dict):
                    continue
                view_path = str(view.get("path") or f"view-{index + 1}")
                if not _is_visible_reference_view(view, user_id, view_path):
                    continue
                title = str(view.get("title") or view_path)
                options.append(
                    {
                        "id": f"{storage_path.name}::{index}",
                        "dashboard": dashboard_title,
                        "dashboard_path": dashboard_url,
                        "storage": storage_path.name,
                        "title": title,
                        "path": view_path,
                        "url": f"{dashboard_url}/{view_path}",
                        "card_count": _count_cards(view),
                    }
                )
        return options

    return await hass.async_add_executor_job(read_views)


def _is_visible_reference_view(
    view: dict[str, Any],
    user_id: str,
    view_path: str,
) -> bool:
    if view_path == "urdash-preview":
        return False
    if view.get("subview") is True:
        return False

    visible = view.get("visible")
    if visible is None:
        return True
    if isinstance(visible, bool):
        return visible
    if isinstance(visible, str):
        return visible == user_id
    if isinstance(visible, dict):
        return visible.get("user") == user_id or visible.get("users") == user_id
    if isinstance(visible, list):
        if not visible:
            return False
        for rule in visible:
            if isinstance(rule, str) and rule == user_id:
                return True
            if isinstance(rule, dict):
                user = rule.get("user")
                users = rule.get("users")
                if user == user_id:
                    return True
                if isinstance(users, list) and user_id in users:
                    return True
                if users == user_id:
                    return True
        return False

    return True


async def _async_reference_dashboard_from_message(
    hass: HomeAssistant,
    msg: dict[str, Any],
) -> dict[str, Any] | None:
    reference_view_id = msg.get("reference_view_id")
    if reference_view_id:
        return await _async_reference_dashboard_for_view(hass, reference_view_id)
    return _normalize_reference_dashboard(msg.get("reference_dashboard"))


async def _async_reference_dashboard_for_view(
    hass: HomeAssistant,
    reference_view_id: str,
) -> dict[str, Any] | None:
    def read_reference() -> dict[str, Any] | None:
        try:
            storage_name, index_text = reference_view_id.split("::", 1)
            view_index = int(index_text)
        except (ValueError, TypeError):
            return None

        for storage_path, _payload, config in _editable_lovelace_storage_candidates(hass):
            if storage_path.name != storage_name:
                continue
            views = config.get("views", [])
            if view_index < 0 or view_index >= len(views):
                return None
            view = views[view_index]
            if not isinstance(view, dict):
                return None
            return {
                "title": config.get("title") or _dashboard_title_from_storage(storage_path),
                "views": [view],
                "reference": {
                    "storage": storage_path.name,
                    "dashboard_path": _dashboard_url_for_storage(storage_path),
                    "view_index": view_index,
                    "view_title": view.get("title"),
                    "view_path": view.get("path"),
                },
            }
        return None

    return await hass.async_add_executor_job(read_reference)


def _dashboard_title_from_storage(storage_path: Path) -> str:
    if storage_path.name == "lovelace":
        return "Overview"
    return storage_path.name.removeprefix("lovelace.").replace("_", " ").replace("-", " ").title()


def _dashboard_url_for_storage(storage_path: Path) -> str:
    if storage_path.name == "lovelace":
        return "/lovelace"
    return f"/{storage_path.name.removeprefix('lovelace.')}"


def _count_cards(value: Any) -> int:
    if isinstance(value, dict):
        count = 1 if "type" in value else 0
        return count + sum(_count_cards(child) for child in value.values())
    if isinstance(value, list):
        return sum(_count_cards(child) for child in value)
    return 0


def _unique_view_path(requested_path: str, views: list[Any]) -> str:
    base = _slugify(requested_path)
    existing = {
        view.get("path")
        for view in views
        if isinstance(view, dict) and view.get("path")
    }

    if base not in existing:
        return base

    suffix = 2
    while f"{base}-{suffix}" in existing:
        suffix += 1
    return f"{base}-{suffix}"


def _slugify(value: str) -> str:
    slug = "".join(char.lower() if char.isalnum() else "-" for char in value)
    slug = "-".join(part for part in slug.split("-") if part)
    return slug or "urdash"
