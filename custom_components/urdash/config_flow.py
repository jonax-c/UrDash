from __future__ import annotations

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.helpers import selector

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
)

THEME_OPTIONS = ["aurora", "quiet", "graphite", "calm", "sunrise"]
HEIGHT_MODE_OPTIONS = ["auto", "viewport", "fixed"]


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
    return vol.Schema(
        {
            vol.Required(
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
                CONF_DEFAULT_THEME,
                default=current.get(CONF_DEFAULT_THEME, DEFAULT_THEME),
            ): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=THEME_OPTIONS,
                    mode=selector.SelectSelectorMode.DROPDOWN,
                )
            ),
            vol.Optional(
                CONF_DEFAULT_HEIGHT_MODE,
                default=current.get(CONF_DEFAULT_HEIGHT_MODE, DEFAULT_HEIGHT_MODE),
            ): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=HEIGHT_MODE_OPTIONS,
                    mode=selector.SelectSelectorMode.DROPDOWN,
                )
            ),
        }
    )


def _normalize_input(user_input):
    normalized = dict(user_input)
    normalized[CONF_BASE_URL] = normalized.get(CONF_BASE_URL, DEFAULT_OPENAI_BASE_URL).rstrip("/")
    return normalized
