from __future__ import annotations

from pathlib import Path
from typing import Any

import voluptuous as vol

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

from .ai_client import AiGenerationError, async_generate_with_openai
from .const import (
    CONF_API_KEY,
    CONF_BASE_URL,
    CONF_DEFAULT_HEIGHT_MODE,
    CONF_DEFAULT_THEME,
    CONF_MODEL,
    DEFAULT_HEIGHT_MODE,
    DEFAULT_OPENAI_BASE_URL,
    DEFAULT_OPENAI_MODEL,
    DEFAULT_THEME,
    DOMAIN,
    FRONTEND_DIR,
    FRONTEND_JS,
    FRONTEND_VERSION,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL,
    STATIC_URL,
)
from .style_presets import STYLES, STYLE_PRESETS, resolve_style

PLATFORMS: list[str] = []

SERVICE_GENERATE_CARD = "generate_card"
THEMES = ["aurora", "quiet", "graphite", "calm", "sunrise"]
HEIGHT_MODES = ["auto", "viewport", "fixed"]

GENERATE_SERVICE_SCHEMA = vol.Schema(
    {
        vol.Required("request"): cv.string,
        vol.Optional("style", default="auto"): vol.In(STYLES),
        vol.Optional("theme", default=DEFAULT_THEME): vol.In(THEMES),
        vol.Optional("height_mode", default=DEFAULT_HEIGHT_MODE): vol.In(HEIGHT_MODES),
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

    await hass.http.async_register_static_path(STATIC_URL, str(static_path), True)


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
    websocket_api.async_register_command(hass, websocket_settings)
    websocket_api.async_register_command(hass, websocket_generate)


def _register_services(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, SERVICE_GENERATE_CARD):
        return

    async def handle_generate(call: ServiceCall) -> None:
        result = await _async_generate_from_hass(
            hass,
            request=call.data["request"],
            style=call.data["style"],
            theme=call.data["theme"],
            height_mode=call.data["height_mode"],
            selected_entity_ids=call.data.get("entity_ids"),
        )
        hass.bus.async_fire(f"{DOMAIN}_card_generated", result)

    hass.services.async_register(
        DOMAIN,
        SERVICE_GENERATE_CARD,
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
            "default_theme": settings[CONF_DEFAULT_THEME],
            "default_height_mode": settings[CONF_DEFAULT_HEIGHT_MODE],
            "style_presets": [
                {"id": style_id, **preset}
                for style_id, preset in STYLE_PRESETS.items()
            ],
            "schema": 2,
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "urdash/generate",
        vol.Required("request"): cv.string,
        vol.Optional("style", default="auto"): vol.In(STYLES),
        vol.Optional("theme", default=DEFAULT_THEME): vol.In(THEMES),
        vol.Optional("height_mode", default=DEFAULT_HEIGHT_MODE): vol.In(HEIGHT_MODES),
        vol.Optional("selected_entity_ids"): [cv.entity_id],
    }
)
@websocket_api.async_response
async def websocket_generate(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Generate an UrDash v2 card."""
    result = await _async_generate_from_hass(
        hass,
        request=msg["request"],
        style=msg["style"],
        theme=msg["theme"],
        height_mode=msg["height_mode"],
        selected_entity_ids=msg.get("selected_entity_ids"),
    )
    connection.send_result(msg["id"], result)


async def _async_generate_from_hass(
    hass: HomeAssistant,
    *,
    request: str,
    style: str,
    theme: str,
    height_mode: str,
    selected_entity_ids: list[str] | None = None,
) -> dict[str, Any]:
    entities = _serialize_states_with_registry(hass)
    if selected_entity_ids is not None:
        selected = set(selected_entity_ids)
        entities = [entity for entity in entities if entity["entity_id"] in selected]

    settings = _settings(hass)
    if not settings[CONF_API_KEY]:
        return {
            "error": "OpenAI API key is not configured.",
            "summary": "Configure an API key in UrDash integration options.",
            "engine": "ai",
            "schema": 2,
        }

    try:
        preferred_theme, style_guidance = resolve_style(style, theme)
        return await async_generate_with_openai(
            hass,
            api_key=settings[CONF_API_KEY],
            base_url=settings[CONF_BASE_URL],
            model=settings[CONF_MODEL],
            request=request,
            entities=entities,
            available_services=_available_services(hass),
            theme=preferred_theme,
            style=style,
            style_guidance=style_guidance,
            height_mode=height_mode,
        )
    except AiGenerationError as err:
        return {
            "error": str(err),
            "summary": "AI generation failed.",
            "engine": "ai",
            "schema": 2,
        }


def _serialize_states_with_registry(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Return states enriched with entity/device/area registry metadata."""
    entity_registry = er.async_get(hass)
    device_registry = dr.async_get(hass)
    area_registry = ar.async_get(hass)
    serialized = []

    for state in hass.states.async_all():
        entity = _serialize_state(state)
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


def _serialize_state(state: Any) -> dict[str, Any]:
    """Convert a Home Assistant State object into panel-friendly data."""
    return {
        "entity_id": state.entity_id,
        "state": state.state,
        "attributes": dict(state.attributes),
    }


def _available_services(hass: HomeAssistant) -> set[str]:
    """Return currently registered Home Assistant service IDs."""
    return {
        f"{domain}.{service}"
        for domain, services in hass.services.async_services().items()
        for service in services
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
        CONF_DEFAULT_THEME: data.get(CONF_DEFAULT_THEME, DEFAULT_THEME),
        CONF_DEFAULT_HEIGHT_MODE: data.get(CONF_DEFAULT_HEIGHT_MODE, DEFAULT_HEIGHT_MODE),
    }
