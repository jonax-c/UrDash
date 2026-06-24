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
from homeassistant.helpers import config_validation as cv

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
                "js_url": f"{STATIC_URL}/{FRONTEND_JS}",
                "embed_iframe": False,
                "trust_external_script": False,
            }
        },
    )


def _register_websocket_commands(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, websocket_entities)
    websocket_api.async_register_command(hass, websocket_resources)
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
            "entities": [serialize_state(state) for state in hass.states.async_all()],
            "source": "home-assistant",
        },
    )


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
        vol.Optional("mode", default="dashboard"): vol.In(["dashboard", "new_view"]),
        vol.Optional("reference_dashboard"): dict,
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
        _normalize_reference_dashboard(msg.get("reference_dashboard")),
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
) -> dict[str, Any]:
    entities = [serialize_state(state) for state in hass.states.async_all()]
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
    storage_dir = Path(hass.config.path(".storage"))
    candidates = [
        storage_dir / "lovelace",
        *sorted(storage_dir.glob("lovelace.*")),
    ]

    skipped_names = {"lovelace_resources", "lovelace_dashboards"}
    checked = []

    for storage_path in candidates:
        if not storage_path.exists() or storage_path.name in skipped_names:
            continue

        checked.append(storage_path.name)
        try:
            payload = json.loads(storage_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        config = (payload.get("data") or {}).get("config")
        if isinstance(config, dict) and isinstance(config.get("views"), list):
            return storage_path, payload, config

    checked_text = ", ".join(checked) if checked else "none"
    raise ValueError(
        "No editable UI-managed Lovelace dashboard storage was found. "
        "This usually means the dashboard is YAML-mode, storage uses an unsupported format, "
        f"or no UI-managed dashboard has been created yet. Checked: {checked_text}."
    )


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
