from __future__ import annotations

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.helpers import selector

from .const import (
    AI_PROVIDER_LOCAL,
    AI_PROVIDER_OPENAI,
    CONF_AI_PROVIDER,
    CONF_ALLOW_CUSTOM_CARDS,
    CONF_API_KEY,
    CONF_BASE_URL,
    CONF_DEFAULT_STYLE,
    CONF_MODEL,
    DEFAULT_ALLOW_CUSTOM_CARDS,
    DEFAULT_AI_PROVIDER,
    DEFAULT_OPENAI_BASE_URL,
    DEFAULT_OPENAI_MODEL,
    DEFAULT_STYLE,
    DOMAIN,
)

STYLE_OPTIONS = ["modern", "minimal", "glass", "compact"]
PROVIDER_OPTIONS = [AI_PROVIDER_OPENAI, AI_PROVIDER_LOCAL]


class UrDashConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle an UrDash config flow."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        """Create the single UrDash config entry."""
        errors = {}

        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            user_input = _normalize_input(user_input)
            return self.async_create_entry(title="UrDash", data=user_input)

        return self.async_show_form(
            step_id="user",
            data_schema=_schema({}),
            errors=errors,
        )

    @staticmethod
    def async_get_options_flow(config_entry):
        """Return the options flow handler."""
        return UrDashOptionsFlow(config_entry)


class UrDashOptionsFlow(config_entries.OptionsFlow):
    """Handle UrDash options."""

    def __init__(self, config_entry):
        self.config_entry = config_entry

    async def async_step_init(self, user_input=None):
        """Manage UrDash options."""
        current = {**self.config_entry.data, **self.config_entry.options}

        if user_input is not None:
            user_input = _normalize_input(user_input)
            data = {**self.config_entry.data, **user_input}
            self.hass.config_entries.async_update_entry(self.config_entry, data=data)
            return self.async_create_entry(title="", data={})

        return self.async_show_form(
            step_id="init",
            data_schema=_schema(current),
        )


def _schema(current):
    provider = current.get(CONF_AI_PROVIDER, DEFAULT_AI_PROVIDER)
    return vol.Schema(
        {
            vol.Optional(
                CONF_AI_PROVIDER,
                default=provider,
            ): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=PROVIDER_OPTIONS,
                    mode=selector.SelectSelectorMode.DROPDOWN,
                )
            ),
            vol.Optional(
                CONF_API_KEY,
                default=current.get(CONF_API_KEY, ""),
            ): selector.TextSelector(
                selector.TextSelectorConfig(
                    type=selector.TextSelectorType.PASSWORD,
                )
            ),
            vol.Optional(
                CONF_MODEL,
                default=current.get(CONF_MODEL, DEFAULT_OPENAI_MODEL),
            ): str,
            vol.Optional(
                CONF_BASE_URL,
                default=current.get(CONF_BASE_URL, DEFAULT_OPENAI_BASE_URL),
            ): str,
            vol.Optional(
                CONF_DEFAULT_STYLE,
                default=current.get(CONF_DEFAULT_STYLE, DEFAULT_STYLE),
            ): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=STYLE_OPTIONS,
                    mode=selector.SelectSelectorMode.DROPDOWN,
                )
            ),
            vol.Optional(
                CONF_ALLOW_CUSTOM_CARDS,
                default=current.get(CONF_ALLOW_CUSTOM_CARDS, DEFAULT_ALLOW_CUSTOM_CARDS),
            ): bool,
        }
    )


def _normalize_input(user_input):
    normalized = dict(user_input)
    if normalized.get(CONF_AI_PROVIDER) == AI_PROVIDER_LOCAL:
        normalized[CONF_API_KEY] = ""
    normalized[CONF_BASE_URL] = normalized.get(CONF_BASE_URL, DEFAULT_OPENAI_BASE_URL).rstrip("/")
    return normalized
