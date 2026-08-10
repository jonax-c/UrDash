from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.helpers import selector

from .chatgpt_session import ChatGptSessionError, get_chatgpt_session
from .const import (
    CONF_ACCOUNT_ACTION,
    CONF_DEFAULT_HEIGHT_MODE,
    CONF_DEFAULT_THEME,
    CONF_MODEL,
    DEFAULT_CODEX_MODEL,
    DEFAULT_HEIGHT_MODE,
    DEFAULT_THEME,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)

THEME_OPTIONS = ["aurora", "quiet", "graphite", "calm", "sunrise"]
HEIGHT_MODE_OPTIONS = ["auto", "viewport", "fixed"]
ACCOUNT_ACTIONS = [
    {"value": "keep", "label": "Keep current ChatGPT login"},
    {"value": "connect", "label": "Sign in with ChatGPT"},
    {"value": "logout", "label": "Sign out"},
]


class _DeviceLoginMixin:
    """Shared device-code login steps for setup and options flows."""

    _login_id: str | None = None
    _login_data: dict[str, str] | None = None

    async def _async_start_login(self):
        try:
            self._login_data = await get_chatgpt_session(
                self.hass
            ).async_start_device_login()
        except ChatGptSessionError as err:
            _LOGGER.error("Could not start ChatGPT login: %s", err)
            return None
        self._login_id = self._login_data["login_id"]
        return self._async_show_login_form()

    async def _async_check_login(self):
        if self._login_id is None or self._login_data is None:
            return {"status": "expired"}
        return await get_chatgpt_session(self.hass).async_login_status(self._login_id)

    def _async_show_login_form(self, error: str | None = None):
        errors = {"base": error} if error else {}
        return self.async_show_form(
            step_id="chatgpt",
            data_schema=vol.Schema({}),
            errors=errors,
            description_placeholders={
                "verification_url": self._login_data["verification_url"],
                "user_code": self._login_data["user_code"],
            },
        )


class UrDashConfigFlow(_DeviceLoginMixin, config_entries.ConfigFlow, domain=DOMAIN):
    """Set up UrDash with a ChatGPT subscription."""

    VERSION = 2

    def __init__(self) -> None:
        self._pending_data: dict[str, Any] = {}

    async def async_step_user(self, user_input=None):
        """Collect preferences before starting ChatGPT device login."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            self._pending_data = _normalize_preferences(user_input)
            result = await self._async_start_login()
            if result is not None:
                return result
            return self.async_show_form(
                step_id="user",
                data_schema=_preferences_schema(self._pending_data),
                errors={"base": "cannot_start_login"},
            )

        return self.async_show_form(
            step_id="user",
            data_schema=_preferences_schema({}),
        )

    async def async_step_chatgpt(self, user_input=None):
        """Complete the ChatGPT device-code login."""
        if user_input is None:
            return self._async_show_login_form()

        status = await self._async_check_login()
        if status["status"] == "pending":
            return self._async_show_login_form("authorization_pending")
        if status["status"] != "complete":
            return self._async_show_login_form("authorization_failed")
        return self.async_create_entry(title="UrDash", data=self._pending_data)

    @staticmethod
    def async_get_options_flow(config_entry):
        """Return the options flow handler."""
        return UrDashOptionsFlow(config_entry)


class UrDashOptionsFlow(_DeviceLoginMixin, config_entries.OptionsFlow):
    """Manage preferences and the ChatGPT account session."""

    def __init__(self, config_entry):
        self.config_entry = config_entry
        self._pending_data: dict[str, Any] = {}

    async def async_step_init(self, user_input=None):
        """Update preferences, reconnect, or sign out."""
        current = {**self.config_entry.data, **self.config_entry.options}

        if user_input is not None:
            account_action = user_input.pop(CONF_ACCOUNT_ACTION, "keep")
            self._pending_data = _normalize_preferences(user_input)
            self._save_preferences()

            if account_action == "connect":
                result = await self._async_start_login()
                if result is not None:
                    return result
                return self.async_show_form(
                    step_id="init",
                    data_schema=_options_schema(self._pending_data),
                    errors={"base": "cannot_start_login"},
                )
            if account_action == "logout":
                try:
                    await get_chatgpt_session(self.hass).async_logout()
                except ChatGptSessionError:
                    return self.async_show_form(
                        step_id="init",
                        data_schema=_options_schema(self._pending_data),
                        errors={"base": "logout_failed"},
                    )
            return self.async_create_entry(title="", data={})

        return self.async_show_form(
            step_id="init",
            data_schema=_options_schema(current),
        )

    async def async_step_chatgpt(self, user_input=None):
        """Complete a replacement ChatGPT login."""
        if user_input is None:
            return self._async_show_login_form()

        status = await self._async_check_login()
        if status["status"] == "pending":
            return self._async_show_login_form("authorization_pending")
        if status["status"] != "complete":
            return self._async_show_login_form("authorization_failed")
        return self.async_create_entry(title="", data={})

    def _save_preferences(self) -> None:
        self.hass.config_entries.async_update_entry(
            self.config_entry,
            data=self._pending_data,
            options={},
            version=UrDashConfigFlow.VERSION,
        )


def _preferences_schema(current: dict[str, Any]) -> vol.Schema:
    return vol.Schema(
        {
            vol.Optional(
                CONF_MODEL,
                default=current.get(CONF_MODEL, DEFAULT_CODEX_MODEL),
            ): selector.TextSelector(),
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


def _options_schema(current: dict[str, Any]) -> vol.Schema:
    schema = dict(_preferences_schema(current).schema)
    schema[
        vol.Optional(CONF_ACCOUNT_ACTION, default="keep")
    ] = selector.SelectSelector(
        selector.SelectSelectorConfig(
            options=ACCOUNT_ACTIONS,
            mode=selector.SelectSelectorMode.DROPDOWN,
        )
    )
    return vol.Schema(schema)


def _normalize_preferences(user_input: dict[str, Any]) -> dict[str, Any]:
    return {
        CONF_MODEL: str(user_input.get(CONF_MODEL, DEFAULT_CODEX_MODEL)).strip()
        or DEFAULT_CODEX_MODEL,
        CONF_DEFAULT_THEME: user_input.get(CONF_DEFAULT_THEME, DEFAULT_THEME),
        CONF_DEFAULT_HEIGHT_MODE: user_input.get(
            CONF_DEFAULT_HEIGHT_MODE, DEFAULT_HEIGHT_MODE
        ),
    }
