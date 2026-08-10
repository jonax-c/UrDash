from __future__ import annotations

import asyncio
import base64
from dataclasses import asdict, dataclass, field
import json
import logging
import math
import os
from pathlib import Path
import secrets
import time
from typing import Any
import uuid

from aiohttp import ClientError, WSMsgType, WSServerHandshakeError
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DEFAULT_CODEX_MODEL, DOMAIN, INTEGRATION_VERSION

_LOGGER = logging.getLogger(__name__)

SESSION_KEY = "_chatgpt_session"
OPENAI_AUTH_BASE_URL = "https://auth.openai.com"
OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
OPENAI_DEVICE_CALLBACK_URL = f"{OPENAI_AUTH_BASE_URL}/deviceauth/callback"
OPENAI_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"
OPENAI_CODEX_RESPONSES_WS_URL = "wss://chatgpt.com/backend-api/codex/responses"
RESPONSES_WEBSOCKET_BETA = "responses_websockets=2026-02-06"
DEVICE_LOGIN_TIMEOUT_SECONDS = 15 * 60
REQUEST_TIMEOUT_SECONDS = 30
GENERATION_TIMEOUT_SECONDS = 120
DEFAULT_POLL_INTERVAL_SECONDS = 5
MIN_POLL_INTERVAL_SECONDS = 1
TOKEN_REFRESH_MARGIN_SECONDS = 60
AUTH_BODY_LIMIT = 256 * 1024
ERROR_BODY_LIMIT = 16 * 1024
GENERATION_BODY_LIMIT = 16 * 1024 * 1024


class ChatGptSessionError(Exception):
    """Raised when ChatGPT OAuth or Codex Responses cannot complete."""


class _ChatGptHttpError(ChatGptSessionError):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


class _ChatGptTransportError(ChatGptSessionError):
    """Raised for temporary network failures that device polling may retry."""


@dataclass(slots=True)
class _Credentials:
    access: str
    refresh: str
    expires: int
    account_id: str
    plan_type: str | None = None


@dataclass(slots=True)
class _LoginAttempt:
    login_id: str
    device_auth_id: str
    verification_url: str
    user_code: str
    interval_seconds: int
    task: asyncio.Task
    saved: bool = False


@dataclass(slots=True)
class _ResponseCollector:
    fragments: list[str] = field(default_factory=list)
    completed_text: str | None = None
    completed: bool = False

    def consume(self, data: str) -> bool:
        if data == "[DONE]":
            self.completed = True
            return True
        try:
            event = json.loads(data)
        except json.JSONDecodeError:
            return False
        if not isinstance(event, dict):
            return False

        event_type = event.get("type")
        if event_type == "response.output_text.delta" and isinstance(
            event.get("delta"), str
        ):
            self.fragments.append(event["delta"])
        elif event_type == "response.output_text.done" and isinstance(
            event.get("text"), str
        ):
            self.completed_text = event["text"]
        elif event_type == "response.completed" and isinstance(
            event.get("response"), dict
        ):
            try:
                self.completed_text = _extract_output_text(event["response"])
            except KeyError:
                pass
            self.completed = True
            return True
        elif event_type in {"error", "response.failed", "response.incomplete"}:
            raise ChatGptSessionError(_sse_error_message(event))
        return False

    def result(self) -> str:
        if self.completed_text:
            return self.completed_text
        if self.fragments:
            return "".join(self.fragments)
        raise ChatGptSessionError("ChatGPT returned no final response.")


class ChatGptSession:
    """Manage ChatGPT OAuth and direct subscription-backed model requests."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._auth_path = Path(
            hass.config.path(".storage", "urdash_chatgpt_auth.json")
        )
        self._credentials: _Credentials | None = None
        self._credentials_loaded = False
        self._credentials_lock = asyncio.Lock()
        self._refresh_lock = asyncio.Lock()
        self._login_lock = asyncio.Lock()
        self._login_attempt: _LoginAttempt | None = None

    async def async_account_status(self, *, refresh: bool = False) -> dict[str, Any]:
        """Return safe account metadata without exposing OAuth credentials."""
        credentials = await self._async_load_credentials()
        if credentials is None:
            return _account_status(authenticated=False)

        should_refresh = refresh or credentials.expires <= _now_ms() + (
            TOKEN_REFRESH_MARGIN_SECONDS * 1000
        )
        if should_refresh:
            try:
                credentials = await self._async_refresh_credentials()
            except ChatGptSessionError as err:
                return _account_status(authenticated=False, error=str(err))

        return _account_status(
            authenticated=True,
            plan_type=credentials.plan_type,
        )

    async def async_start_device_login(self) -> dict[str, str]:
        """Start OpenAI's device-code flow and return public verification data."""
        async with self._login_lock:
            await self._async_cancel_login_locked()
            payload = await self._async_auth_json_request(
                f"{OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode",
                json_body={"client_id": OPENAI_CODEX_CLIENT_ID},
            )
            device_auth_id = _non_empty_string(payload.get("device_auth_id"))
            user_code = _non_empty_string(payload.get("user_code")) or _non_empty_string(
                payload.get("usercode")
            )
            if not device_auth_id or not user_code:
                raise ChatGptSessionError(
                    "OpenAI device-code response did not include the required codes."
                )

            interval = _positive_number(payload.get("interval"))
            interval_seconds = max(
                MIN_POLL_INTERVAL_SECONDS,
                int(interval or DEFAULT_POLL_INTERVAL_SECONDS),
            )
            login_id = secrets.token_urlsafe(18)
            task = self._hass.async_create_task(
                self._async_complete_device_login(
                    device_auth_id=device_auth_id,
                    user_code=user_code,
                    interval_seconds=interval_seconds,
                ),
                f"{DOMAIN} ChatGPT login",
            )
            self._login_attempt = _LoginAttempt(
                login_id=login_id,
                device_auth_id=device_auth_id,
                verification_url=f"{OPENAI_AUTH_BASE_URL}/codex/device",
                user_code=user_code,
                interval_seconds=interval_seconds,
                task=task,
            )
            return self._login_public_data(self._login_attempt)

    async def async_login_status(self, login_id: str) -> dict[str, Any]:
        """Poll a device-code attempt without exposing OAuth material."""
        async with self._login_lock:
            attempt = self._login_attempt
            if attempt is None or attempt.login_id != login_id:
                return {"status": "expired", "error": "The login attempt is no longer active."}
            if not attempt.task.done():
                return {"status": "pending", **self._login_public_data(attempt)}

            try:
                credentials = attempt.task.result()
            except Exception as err:
                return {"status": "failed", "error": _friendly_error(err)}

            if not attempt.saved:
                await self._async_store_credentials(credentials)
                attempt.saved = True
            return {"status": "complete"}

    async def async_logout(self) -> None:
        """Clear the locally stored ChatGPT session."""
        async with self._login_lock:
            await self._async_cancel_login_locked()
        async with self._credentials_lock:
            self._credentials = None
            self._credentials_loaded = True
            try:
                await self._hass.async_add_executor_job(self._delete_auth_file)
            except OSError as err:
                raise ChatGptSessionError(
                    "Home Assistant could not remove the stored ChatGPT session."
                ) from err

    async def async_generate_structured(
        self,
        *,
        developer_instructions: str,
        input_text: str,
        output_schema: dict[str, Any],
        model: str | None,
    ) -> str:
        """Call ChatGPT's Codex Responses endpoint without a local runtime."""
        credentials = await self._async_valid_credentials()
        for attempt in range(2):
            try:
                return await self._async_post_generation(
                    credentials=credentials,
                    developer_instructions=developer_instructions,
                    input_text=input_text,
                    output_schema=output_schema,
                    model=model or DEFAULT_CODEX_MODEL,
                )
            except _ChatGptHttpError as err:
                if err.status != 401 or attempt > 0:
                    raise
                credentials = await self._async_refresh_credentials(force=True)
        raise ChatGptSessionError("ChatGPT generation failed after authentication retry.")

    async def async_close(self) -> None:
        """Cancel any pending device-code poller."""
        async with self._login_lock:
            await self._async_cancel_login_locked()

    async def _async_complete_device_login(
        self,
        *,
        device_auth_id: str,
        user_code: str,
        interval_seconds: int,
    ) -> _Credentials:
        deadline = time.monotonic() + DEVICE_LOGIN_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            try:
                status, payload = await self._async_auth_request(
                    f"{OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/token",
                    json_body={
                        "device_auth_id": device_auth_id,
                        "user_code": user_code,
                    },
                    allowed_error_statuses={403, 404},
                )
            except _ChatGptTransportError as err:
                _LOGGER.debug("Retrying ChatGPT device authorization: %s", err)
                await asyncio.sleep(
                    min(interval_seconds, max(0.0, deadline - time.monotonic()))
                )
                continue
            if status == 200:
                authorization_code = _non_empty_string(payload.get("authorization_code"))
                code_verifier = _non_empty_string(payload.get("code_verifier"))
                if not authorization_code or not code_verifier:
                    raise ChatGptSessionError(
                        "OpenAI device authorization did not return an exchange code."
                    )
                return await self._async_exchange_device_code(
                    authorization_code, code_verifier
                )
            await asyncio.sleep(
                min(interval_seconds, max(0.0, deadline - time.monotonic()))
            )
        raise ChatGptSessionError("ChatGPT device authorization timed out after 15 minutes.")

    async def _async_exchange_device_code(
        self, authorization_code: str, code_verifier: str
    ) -> _Credentials:
        payload = await self._async_auth_json_request(
            f"{OPENAI_AUTH_BASE_URL}/oauth/token",
            form_body={
                "grant_type": "authorization_code",
                "code": authorization_code,
                "redirect_uri": OPENAI_DEVICE_CALLBACK_URL,
                "client_id": OPENAI_CODEX_CLIENT_ID,
                "code_verifier": code_verifier,
            },
        )
        return _credentials_from_token_payload(payload)

    async def _async_refresh_credentials(self, *, force: bool = False) -> _Credentials:
        async with self._refresh_lock:
            credentials = await self._async_load_credentials()
            if credentials is None:
                raise ChatGptSessionError("ChatGPT account is not connected.")
            if not force and credentials.expires > _now_ms() + (
                TOKEN_REFRESH_MARGIN_SECONDS * 1000
            ):
                return credentials

            payload = await self._async_auth_json_request(
                f"{OPENAI_AUTH_BASE_URL}/oauth/token",
                form_body={
                    "grant_type": "refresh_token",
                    "refresh_token": credentials.refresh,
                    "client_id": OPENAI_CODEX_CLIENT_ID,
                },
            )
            refreshed = _credentials_from_token_payload(payload)
            await self._async_store_credentials(refreshed)
            return refreshed

    async def _async_valid_credentials(self) -> _Credentials:
        credentials = await self._async_load_credentials()
        if credentials is None:
            raise ChatGptSessionError("ChatGPT account is not connected.")
        if credentials.expires <= _now_ms() + (TOKEN_REFRESH_MARGIN_SECONDS * 1000):
            return await self._async_refresh_credentials()
        return credentials

    async def _async_post_generation(
        self,
        *,
        credentials: _Credentials,
        developer_instructions: str,
        input_text: str,
        output_schema: dict[str, Any],
        model: str,
    ) -> str:
        request_id = str(uuid.uuid4())
        payload = {
            "model": model,
            "store": False,
            "stream": True,
            "instructions": developer_instructions,
            "input": [
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": input_text}],
                }
            ],
            "text": {
                "verbosity": "low",
                "format": {
                    "type": "json_schema",
                    "name": "urdash_card_v2",
                    "schema": output_schema,
                    "strict": True,
                },
            },
            "include": ["reasoning.encrypted_content"],
        }
        headers = {
            "Authorization": f"Bearer {credentials.access}",
            "chatgpt-account-id": credentials.account_id,
            "originator": "urdash",
            "User-Agent": f"UrDash/{INTEGRATION_VERSION}",
            "session_id": request_id,
            "x-client-request-id": request_id,
        }
        session = async_get_clientsession(self._hass)
        try:
            return await self._async_post_generation_websocket(
                session=session,
                headers=headers,
                payload=payload,
            )
        except _ChatGptHttpError as err:
            if err.status in {401, 429}:
                raise
            _LOGGER.debug(
                "ChatGPT WebSocket handshake failed; using HTTP fallback: %s", err
            )
        except _ChatGptTransportError as err:
            _LOGGER.debug("ChatGPT WebSocket unavailable; using HTTP fallback: %s", err)

        http_headers = {
            **headers,
            "OpenAI-Beta": "responses=experimental",
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
        }
        try:
            async with asyncio.timeout(GENERATION_TIMEOUT_SECONDS):
                async with session.post(
                    OPENAI_CODEX_RESPONSES_URL,
                    headers=http_headers,
                    json=payload,
                    allow_redirects=False,
                ) as response:
                    if response.status >= 400:
                        body = await _read_limited_response(response, ERROR_BODY_LIMIT)
                        raise _ChatGptHttpError(
                            response.status,
                            _format_response_error(response.status, body),
                        )
                    content_type = response.headers.get("Content-Type", "").lower()
                    if "text/event-stream" in content_type:
                        return await _read_sse_output(response)
                    body = await _read_limited_response(response, GENERATION_BODY_LIMIT)
        except TimeoutError as err:
            raise _ChatGptTransportError("ChatGPT generation timed out.") from err
        except ClientError as err:
            raise _ChatGptTransportError(
                "ChatGPT generation could not reach OpenAI."
            ) from err

        try:
            response_json = json.loads(body)
            return _extract_output_text(response_json)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as err:
            raise ChatGptSessionError(
                "ChatGPT returned an unexpected Responses payload."
            ) from err

    async def _async_post_generation_websocket(
        self,
        *,
        session: Any,
        headers: dict[str, str],
        payload: dict[str, Any],
    ) -> str:
        ws_headers = {
            **headers,
            "OpenAI-Beta": RESPONSES_WEBSOCKET_BETA,
        }
        try:
            async with asyncio.timeout(GENERATION_TIMEOUT_SECONDS):
                async with session.ws_connect(
                    OPENAI_CODEX_RESPONSES_WS_URL,
                    headers=ws_headers,
                    heartbeat=30,
                    max_msg_size=GENERATION_BODY_LIMIT,
                ) as websocket:
                    await websocket.send_json({"type": "response.create", **payload})
                    return await _read_websocket_output(websocket)
        except WSServerHandshakeError as err:
            raise _ChatGptHttpError(
                err.status,
                f"ChatGPT WebSocket returned HTTP {err.status}.",
            ) from err
        except TimeoutError as err:
            raise _ChatGptTransportError(
                "ChatGPT WebSocket generation timed out."
            ) from err
        except ClientError as err:
            raise _ChatGptTransportError(
                "ChatGPT WebSocket could not reach OpenAI."
            ) from err

    async def _async_auth_json_request(
        self,
        url: str,
        *,
        json_body: dict[str, Any] | None = None,
        form_body: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        status, payload = await self._async_auth_request(
            url,
            json_body=json_body,
            form_body=form_body,
        )
        if status != 200:
            raise ChatGptSessionError(f"OpenAI authentication returned HTTP {status}.")
        return payload

    async def _async_auth_request(
        self,
        url: str,
        *,
        json_body: dict[str, Any] | None = None,
        form_body: dict[str, str] | None = None,
        allowed_error_statuses: set[int] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        if not url.startswith(f"{OPENAI_AUTH_BASE_URL}/"):
            raise ChatGptSessionError("Refused a non-OpenAI authentication endpoint.")
        headers = {
            "Content-Type": (
                "application/x-www-form-urlencoded" if form_body else "application/json"
            ),
            "originator": "urdash",
            "User-Agent": f"UrDash/{INTEGRATION_VERSION}",
        }
        session = async_get_clientsession(self._hass)
        try:
            async with asyncio.timeout(REQUEST_TIMEOUT_SECONDS):
                async with session.post(
                    url,
                    headers=headers,
                    json=json_body,
                    data=form_body,
                    allow_redirects=False,
                ) as response:
                    body = await _read_limited_response(
                        response,
                        AUTH_BODY_LIMIT if response.status < 400 else ERROR_BODY_LIMIT,
                    )
        except TimeoutError as err:
            raise _ChatGptTransportError(
                "OpenAI authentication request timed out."
            ) from err
        except ClientError as err:
            raise _ChatGptTransportError(
                "OpenAI authentication could not be reached."
            ) from err

        if response.status in (allowed_error_statuses or set()):
            return response.status, {}
        if response.status >= 400:
            raise ChatGptSessionError(_format_response_error(response.status, body))
        if not body:
            return response.status, {}
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as err:
            raise ChatGptSessionError(
                "OpenAI authentication returned invalid JSON."
            ) from err
        if not isinstance(payload, dict):
            raise ChatGptSessionError(
                "OpenAI authentication returned an unexpected response."
            )
        return response.status, payload

    async def _async_load_credentials(self) -> _Credentials | None:
        async with self._credentials_lock:
            if self._credentials_loaded:
                return self._credentials
            self._credentials = await self._hass.async_add_executor_job(
                self._read_auth_file
            )
            self._credentials_loaded = True
            return self._credentials

    async def _async_store_credentials(self, credentials: _Credentials) -> None:
        async with self._credentials_lock:
            try:
                await self._hass.async_add_executor_job(
                    self._write_auth_file, credentials
                )
            except OSError as err:
                raise ChatGptSessionError(
                    "Home Assistant could not securely store the ChatGPT session."
                ) from err
            self._credentials = credentials
            self._credentials_loaded = True

    async def _async_cancel_login_locked(self) -> None:
        attempt = self._login_attempt
        self._login_attempt = None
        if attempt is not None and not attempt.task.done():
            attempt.task.cancel()
            try:
                await attempt.task
            except asyncio.CancelledError:
                pass

    def _read_auth_file(self) -> _Credentials | None:
        if not self._auth_path.exists():
            return None
        try:
            payload = json.loads(self._auth_path.read_text(encoding="utf-8"))
            access = _non_empty_string(payload.get("access"))
            refresh = _non_empty_string(payload.get("refresh"))
            account_id = _non_empty_string(payload.get("account_id"))
            expires = int(payload["expires"])
            if not access or not refresh or not account_id or expires <= 0:
                raise ValueError("Invalid stored ChatGPT credentials")
            return _Credentials(
                access=access,
                refresh=refresh,
                expires=expires,
                account_id=account_id,
                plan_type=_non_empty_string(payload.get("plan_type")),
            )
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            _LOGGER.error("Could not read the stored UrDash ChatGPT session")
            return None

    def _write_auth_file(self, credentials: _Credentials) -> None:
        self._auth_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temp_path = self._auth_path.with_suffix(".tmp")
        temp_path.write_text(
            json.dumps(asdict(credentials), separators=(",", ":")),
            encoding="utf-8",
        )
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, self._auth_path)
        os.chmod(self._auth_path, 0o600)

    def _delete_auth_file(self) -> None:
        try:
            self._auth_path.unlink()
        except FileNotFoundError:
            pass

    @staticmethod
    def _login_public_data(attempt: _LoginAttempt) -> dict[str, str]:
        return {
            "login_id": attempt.login_id,
            "verification_url": attempt.verification_url,
            "user_code": attempt.user_code,
        }


def get_chatgpt_session(hass: HomeAssistant) -> ChatGptSession:
    """Return the Home Assistant-wide ChatGPT subscription session."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    session = domain_data.get(SESSION_KEY)
    if session is None:
        session = ChatGptSession(hass)
        domain_data[SESSION_KEY] = session
    return session


async def _read_limited_response(response: Any, limit: int) -> str:
    chunks: list[bytes] = []
    total = 0
    while total <= limit:
        chunk = await response.content.read(min(64 * 1024, limit + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    if total > limit:
        raise ChatGptSessionError("OpenAI response exceeded the allowed size.")
    return b"".join(chunks).decode("utf-8", errors="replace")


async def _read_sse_output(response: Any) -> str:
    total = 0
    data_lines: list[str] = []
    collector = _ResponseCollector()

    async for raw_line in response.content:
        total += len(raw_line)
        if total > GENERATION_BODY_LIMIT:
            raise ChatGptSessionError("ChatGPT response exceeded the allowed size.")
        line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
            continue
        if line or not data_lines:
            continue

        data = "\n".join(data_lines)
        data_lines.clear()
        if collector.consume(data):
            break

    if data_lines:
        collector.consume("\n".join(data_lines))
    return collector.result()


async def _read_websocket_output(websocket: Any) -> str:
    total = 0
    collector = _ResponseCollector()
    async for message in websocket:
        if message.type == WSMsgType.TEXT:
            total += len(message.data.encode("utf-8"))
            if total > GENERATION_BODY_LIMIT:
                raise ChatGptSessionError("ChatGPT response exceeded the allowed size.")
            if collector.consume(message.data):
                return collector.result()
            continue
        if message.type == WSMsgType.BINARY:
            raise _ChatGptTransportError(
                "ChatGPT WebSocket returned an unexpected binary message."
            )
        if message.type == WSMsgType.ERROR:
            raise _ChatGptTransportError("ChatGPT WebSocket stream failed.")
        if message.type in {WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.CLOSING}:
            break

    raise _ChatGptTransportError(
        "ChatGPT WebSocket closed before response.completed."
    )


def _credentials_from_token_payload(payload: dict[str, Any]) -> _Credentials:
    access = _non_empty_string(payload.get("access_token"))
    refresh = _non_empty_string(payload.get("refresh_token"))
    expires_in = _positive_number(payload.get("expires_in"))
    if not access or not refresh:
        raise ChatGptSessionError("OpenAI token exchange did not return OAuth credentials.")
    identity = _decode_access_token(access)
    account_id = _non_empty_string(
        identity.get("https://api.openai.com/auth", {}).get("chatgpt_account_id")
    )
    if not account_id:
        raise ChatGptSessionError("OpenAI token did not include a ChatGPT account ID.")
    expires = (
        _now_ms() + int(expires_in * 1000)
        if expires_in is not None
        else int(_positive_number(identity.get("exp")) or 0) * 1000
    )
    if expires <= _now_ms():
        raise ChatGptSessionError("OpenAI token did not include a valid expiry.")
    plan_type = _non_empty_string(
        identity.get("https://api.openai.com/auth", {}).get("chatgpt_plan_type")
    )
    return _Credentials(
        access=access,
        refresh=refresh,
        expires=expires,
        account_id=account_id,
        plan_type=plan_type,
    )


def _decode_access_token(token: str) -> dict[str, Any]:
    parts = token.split(".")
    if len(parts) != 3:
        raise ChatGptSessionError("OpenAI returned an invalid access token.")
    try:
        encoded = parts[1] + ("=" * (-len(parts[1]) % 4))
        payload = json.loads(base64.urlsafe_b64decode(encoded).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as err:
        raise ChatGptSessionError("OpenAI returned an invalid access token.") from err
    if not isinstance(payload, dict):
        raise ChatGptSessionError("OpenAI returned an invalid access token.")
    return payload


def _extract_output_text(response_json: dict[str, Any]) -> str:
    if isinstance(response_json.get("output_text"), str):
        return response_json["output_text"]
    for item in response_json.get("output", []):
        if not isinstance(item, dict):
            continue
        for content in item.get("content", []):
            if (
                isinstance(content, dict)
                and content.get("type") in {"output_text", "text"}
                and isinstance(content.get("text"), str)
            ):
                return content["text"]
    raise KeyError("output_text")


def _format_response_error(status: int, body: str) -> str:
    message = body.strip() or f"HTTP {status}"
    try:
        payload = json.loads(body)
        error = payload.get("error", payload) if isinstance(payload, dict) else {}
        if isinstance(error, dict):
            message = _non_empty_string(error.get("message")) or _non_empty_string(
                error.get("detail")
            ) or message
            code = _non_empty_string(error.get("code")) or _non_empty_string(
                error.get("type")
            )
            if status == 429 or code in {
                "usage_limit_reached",
                "usage_not_included",
                "rate_limit_exceeded",
            }:
                return f"ChatGPT usage limit reached: {message}"
    except json.JSONDecodeError:
        pass
    return f"ChatGPT returned HTTP {status}: {message[:400]}"


def _sse_error_message(event: dict[str, Any]) -> str:
    error = event.get("error")
    if isinstance(error, dict):
        return _non_empty_string(error.get("message")) or "ChatGPT generation failed."
    response = event.get("response")
    if isinstance(response, dict) and isinstance(response.get("error"), dict):
        return _non_empty_string(response["error"].get("message")) or "ChatGPT generation failed."
    return "ChatGPT generation failed."


def _account_status(
    *, authenticated: bool, plan_type: str | None = None, error: str | None = None
) -> dict[str, Any]:
    return {
        "authenticated": authenticated,
        "auth_mode": "chatgpt" if authenticated else None,
        "plan_type": plan_type,
        "requires_auth": not authenticated,
        "error": error,
    }


def _non_empty_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _positive_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def _now_ms() -> int:
    return int(time.time() * 1000)


def _friendly_error(error: Exception) -> str:
    message = str(error).strip() or error.__class__.__name__
    return f"ChatGPT session error: {message}"
