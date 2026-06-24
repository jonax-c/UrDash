from __future__ import annotations

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
    resources = [
        {
            **card,
            "required": card["id"] in {"mushroom", "mini-graph-card"},
            "installed": False,
            "checked": False,
        }
        for card in CUSTOM_CARDS
    ]
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
