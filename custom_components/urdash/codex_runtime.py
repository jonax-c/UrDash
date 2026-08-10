from __future__ import annotations

import asyncio
from dataclasses import dataclass
import logging
import os
from pathlib import Path
from typing import Any

from homeassistant.core import HomeAssistant

from openai_codex import ApprovalMode, AsyncCodex, CodexConfig, Sandbox

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

RUNTIME_KEY = "_codex_runtime"
LOGIN_TIMEOUT_SECONDS = 15 * 60
GENERATION_TIMEOUT_SECONDS = 120
SENSITIVE_ENV_MARKERS = (
    "API_KEY",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "CREDENTIAL",
    "COOKIE",
    "DATABASE_URL",
    "REDIS_URL",
    "PRIVATE_KEY",
)


class CodexRuntimeError(Exception):
    """Raised when the local Codex runtime cannot complete an operation."""


@dataclass(slots=True)
class _LoginAttempt:
    login_id: str
    verification_url: str
    user_code: str
    handle: Any
    task: asyncio.Task


class CodexRuntime:
    """Own the isolated Codex process and ChatGPT subscription session."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._home = Path(hass.config.path(".storage", "urdash_codex"))
        self._workspace = self._home / "workspace"
        self._client: AsyncCodex | None = None
        self._client_lock = asyncio.Lock()
        self._login_lock = asyncio.Lock()
        self._login_attempt: _LoginAttempt | None = None

    async def async_account_status(self, *, refresh: bool = False) -> dict[str, Any]:
        """Return safe account metadata without exposing OAuth credentials."""
        try:
            client = await self._async_client()
            response = await client.account(refresh_token=refresh)
        except Exception as err:
            _LOGGER.debug("Could not read Codex account status: %s", err)
            return {
                "authenticated": False,
                "auth_mode": None,
                "plan_type": None,
                "requires_auth": True,
                "error": _friendly_error(err),
            }

        account = getattr(response, "account", None)
        account_value = getattr(account, "root", account)
        account_type = getattr(account_value, "type", None)
        plan_type = _enum_value(getattr(account_value, "plan_type", None))
        authenticated = account_type == "chatgpt"
        return {
            "authenticated": authenticated,
            "auth_mode": account_type,
            "plan_type": plan_type,
            "requires_auth": bool(getattr(response, "requires_openai_auth", not authenticated)),
            "error": None,
        }

    async def async_start_device_login(self) -> dict[str, str]:
        """Start a ChatGPT device-code login and return only public login data."""
        async with self._login_lock:
            await self._async_cancel_login_locked()
            try:
                client = await self._async_client()
                handle = await client.login_chatgpt_device_code()
            except Exception as err:
                raise CodexRuntimeError(_friendly_error(err)) from err

            task = self._hass.async_create_task(
                self._async_wait_for_login(handle),
                f"{DOMAIN} ChatGPT login",
            )
            self._login_attempt = _LoginAttempt(
                login_id=handle.login_id,
                verification_url=handle.verification_url,
                user_code=handle.user_code,
                handle=handle,
                task=task,
            )
            return self._login_public_data(self._login_attempt)

    async def async_login_status(self, login_id: str) -> dict[str, Any]:
        """Poll a device-code attempt without exposing its credentials."""
        async with self._login_lock:
            attempt = self._login_attempt
            if attempt is None or attempt.login_id != login_id:
                return {"status": "expired", "error": "The login attempt is no longer active."}
            if not attempt.task.done():
                return {"status": "pending", **self._login_public_data(attempt)}

            try:
                completion = attempt.task.result()
            except Exception as err:
                return {"status": "failed", "error": _friendly_error(err)}

            if not bool(getattr(completion, "success", False)):
                return {
                    "status": "failed",
                    "error": getattr(completion, "error", None) or "ChatGPT authorization failed.",
                }

            await self._hass.async_add_executor_job(self._secure_auth_file)
            return {"status": "complete"}

    async def async_logout(self) -> None:
        """Clear the Codex ChatGPT session."""
        async with self._login_lock:
            await self._async_cancel_login_locked()
            try:
                client = await self._async_client()
                await client.logout()
            except Exception as err:
                raise CodexRuntimeError(_friendly_error(err)) from err

    async def async_generate_structured(
        self,
        *,
        developer_instructions: str,
        input_text: str,
        output_schema: dict[str, Any],
        model: str | None,
    ) -> str:
        """Run an approval-denying ephemeral Codex turn and return its final JSON text."""
        try:
            client = await self._async_client()
            thread = await client.thread_start(
                approval_mode=ApprovalMode.deny_all,
                cwd=str(self._workspace),
                developer_instructions=developer_instructions,
                ephemeral=True,
                model=model or None,
                sandbox=Sandbox.read_only,
            )
            async with asyncio.timeout(GENERATION_TIMEOUT_SECONDS):
                result = await thread.run(
                    input_text,
                    approval_mode=ApprovalMode.deny_all,
                    output_schema=output_schema,
                    sandbox=Sandbox.read_only,
                )
        except TimeoutError as err:
            raise CodexRuntimeError("Codex generation timed out.") from err
        except Exception as err:
            raise CodexRuntimeError(_friendly_error(err)) from err

        if getattr(result, "error", None) is not None:
            error = result.error
            message = getattr(error, "message", None) or str(error)
            raise CodexRuntimeError(f"Codex generation failed: {message}")
        if not result.final_response:
            raise CodexRuntimeError("Codex returned no final response.")
        return result.final_response

    async def async_close(self) -> None:
        """Stop login work and the child app-server process."""
        async with self._login_lock:
            await self._async_cancel_login_locked()
        async with self._client_lock:
            if self._client is not None:
                await self._client.close()
                self._client = None

    async def _async_client(self) -> AsyncCodex:
        if self._client is not None:
            return self._client
        async with self._client_lock:
            if self._client is not None:
                return self._client
            await self._hass.async_add_executor_job(self._prepare_directories)
            config = CodexConfig(
                cwd=str(self._workspace),
                env=self._subprocess_env(),
                client_name="urdash_home_assistant",
                client_title="UrDash for Home Assistant",
            )
            client = AsyncCodex(config)
            try:
                await client.__aenter__()
            except Exception:
                await client.close()
                raise
            self._client = client
            return client

    async def _async_wait_for_login(self, handle: Any) -> Any:
        try:
            async with asyncio.timeout(LOGIN_TIMEOUT_SECONDS):
                return await handle.wait()
        except TimeoutError:
            await handle.cancel()
            raise CodexRuntimeError("ChatGPT login timed out. Start a new login attempt.")

    async def _async_cancel_login_locked(self) -> None:
        attempt = self._login_attempt
        if attempt is None:
            return
        self._login_attempt = None
        if not attempt.task.done():
            try:
                await attempt.handle.cancel()
            except Exception:
                _LOGGER.debug("Could not cancel Codex login %s", attempt.login_id, exc_info=True)
            attempt.task.cancel()

    def _prepare_directories(self) -> None:
        self._home.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self._home, 0o700)
        os.chmod(self._workspace, 0o700)

    def _secure_auth_file(self) -> None:
        auth_file = self._home / "auth.json"
        if auth_file.exists():
            os.chmod(auth_file, 0o600)

    def _subprocess_env(self) -> dict[str, str]:
        # The SDK overlays this mapping on the parent environment. Clear common
        # container-secret values while preserving Codex runtime metadata.
        env = {
            key: ""
            for key in os.environ
            if any(marker in key.upper() for marker in SENSITIVE_ENV_MARKERS)
        }
        env.update(
            {
                "HOME": str(self._home),
                "XDG_CONFIG_HOME": str(self._home / "xdg"),
                "CODEX_HOME": str(self._home),
                "OPENAI_API_KEY": "",
                "CODEX_API_KEY": "",
            }
        )
        return env

    @staticmethod
    def _login_public_data(attempt: _LoginAttempt) -> dict[str, str]:
        return {
            "login_id": attempt.login_id,
            "verification_url": attempt.verification_url,
            "user_code": attempt.user_code,
        }


def get_codex_runtime(hass: HomeAssistant) -> CodexRuntime:
    """Return the Home Assistant-wide Codex runtime."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    runtime = domain_data.get(RUNTIME_KEY)
    if runtime is None:
        runtime = CodexRuntime(hass)
        domain_data[RUNTIME_KEY] = runtime
    return runtime


def _enum_value(value: Any) -> str | None:
    if value is None:
        return None
    return getattr(value, "value", str(value))


def _friendly_error(error: Exception) -> str:
    message = str(error).strip()
    if not message:
        message = error.__class__.__name__
    return f"Codex runtime error: {message}"
