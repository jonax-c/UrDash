from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
from pathlib import Path
import sys
import time
import types
import unittest


ROOT = Path(__file__).parents[1]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


homeassistant = types.ModuleType("homeassistant")
core = types.ModuleType("homeassistant.core")
core.HomeAssistant = object
helpers = types.ModuleType("homeassistant.helpers")
aiohttp_client = types.ModuleType("homeassistant.helpers.aiohttp_client")
aiohttp_client.async_get_clientsession = lambda hass: None
aiohttp = types.ModuleType("aiohttp")
aiohttp.ClientError = type("ClientError", (Exception,), {})
aiohttp.WSServerHandshakeError = type(
    "WSServerHandshakeError", (aiohttp.ClientError,), {}
)
aiohttp.WSMsgType = types.SimpleNamespace(
    TEXT="text",
    BINARY="binary",
    ERROR="error",
    CLOSE="close",
    CLOSED="closed",
    CLOSING="closing",
)
sys.modules.update(
    {
        "aiohttp": aiohttp,
        "homeassistant": homeassistant,
        "homeassistant.core": core,
        "homeassistant.helpers": helpers,
        "homeassistant.helpers.aiohttp_client": aiohttp_client,
    }
)
package = types.ModuleType("urdash")
package.__path__ = [str(ROOT / "custom_components" / "urdash")]
sys.modules["urdash"] = package
load_module("urdash.const", ROOT / "custom_components" / "urdash" / "const.py")
chatgpt = load_module(
    "urdash.chatgpt_session",
    ROOT / "custom_components" / "urdash" / "chatgpt_session.py",
)


def fake_access_token(account_id: str = "acct-test", plan: str = "plus") -> str:
    payload = {
        "exp": int(time.time()) + 3600,
        "https://api.openai.com/auth": {
            "chatgpt_account_id": account_id,
            "chatgpt_plan_type": plan,
        },
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"header.{encoded}.signature"


class FakeContent:
    def __init__(self, body: bytes) -> None:
        self.body = body

    async def read(self, limit: int = -1) -> bytes:
        return self.body if limit < 0 else self.body[:limit]

    def __aiter__(self):
        self.lines = iter(self.body.splitlines(keepends=True))
        return self

    async def __anext__(self):
        try:
            return next(self.lines)
        except StopIteration as err:
            raise StopAsyncIteration from err


class FragmentedContent(FakeContent):
    def __init__(self, fragments: list[bytes]) -> None:
        super().__init__(b"".join(fragments))
        self.fragments = iter(fragments)

    async def read(self, limit: int = -1) -> bytes:
        try:
            fragment = next(self.fragments)
        except StopIteration:
            return b""
        if limit >= 0 and len(fragment) > limit:
            raise AssertionError("Test fragment exceeds requested read limit")
        return fragment


class FakeResponse:
    def __init__(self, body: bytes, status: int = 200, content_type: str = "text/event-stream"):
        self.status = status
        self.headers = {"Content-Type": content_type}
        self.content = FakeContent(body)


class FakeRequest:
    def __init__(self, response: FakeResponse) -> None:
        self.response = response

    async def __aenter__(self):
        return self.response

    async def __aexit__(self, exc_type, exc, traceback):
        return False


class FailingRequest:
    def __init__(self, error: Exception) -> None:
        self.error = error

    async def __aenter__(self):
        raise self.error

    async def __aexit__(self, exc_type, exc, traceback):
        return False


class FakeWebSocketMessage:
    def __init__(self, data: str, message_type="text") -> None:
        self.type = message_type
        self.data = data


class FakeWebSocket:
    def __init__(self, messages: list[FakeWebSocketMessage]) -> None:
        self.messages = messages
        self.sent = None

    async def send_json(self, payload):
        self.sent = payload

    def __aiter__(self):
        self.iterator = iter(self.messages)
        return self

    async def __anext__(self):
        try:
            return next(self.iterator)
        except StopIteration as err:
            raise StopAsyncIteration from err


class FakeHttpSession:
    def __init__(
        self, response: FakeResponse, websocket: FakeWebSocket | None = None
    ) -> None:
        self.response = response
        self.websocket = websocket
        self.call = None
        self.ws_call = None

    def post(self, url, **kwargs):
        self.call = {"url": url, **kwargs}
        return FakeRequest(self.response)

    def ws_connect(self, url, **kwargs):
        self.ws_call = {"url": url, **kwargs}
        if self.websocket is None:
            return FailingRequest(aiohttp.ClientError("WebSocket unavailable"))
        return FakeRequest(self.websocket)


class FakeConfig:
    def path(self, *parts):
        return str(Path("/tmp").joinpath(*parts))


class FakeHass:
    def __init__(self) -> None:
        self.config = FakeConfig()
        self.data = {}

    def async_create_task(self, coroutine, name=None):
        return asyncio.create_task(coroutine, name=name)

    async def async_add_executor_job(self, function, *args):
        return function(*args)


class ChatGptSessionTests(unittest.IsolatedAsyncioTestCase):
    def test_token_payload_extracts_account_plan_and_expiry(self):
        credentials = chatgpt._credentials_from_token_payload(
            {
                "access_token": fake_access_token(),
                "refresh_token": "refresh-token",
                "expires_in": 3600,
            }
        )

        self.assertEqual(credentials.account_id, "acct-test")
        self.assertEqual(credentials.plan_type, "plus")
        self.assertGreater(credentials.expires, int(time.time() * 1000))

    async def test_direct_generation_uses_subscription_endpoint_without_tools(self):
        body = (
            'data: {"type":"response.output_text.delta","delta":"{\\"ok\\":"}\n\n'
            'data: {"type":"response.output_text.delta","delta":"true}"}\n\n'
            'data: [DONE]\n\n'
        ).encode()
        http = FakeHttpSession(FakeResponse(body))
        chatgpt.async_get_clientsession = lambda hass: http
        session = chatgpt.ChatGptSession(FakeHass())
        session._credentials_loaded = True
        session._credentials = chatgpt._Credentials(
            access=fake_access_token(),
            refresh="refresh-token",
            expires=int(time.time() * 1000) + 3600_000,
            account_id="acct-test",
            plan_type="plus",
        )

        result = await session.async_generate_structured(
            developer_instructions="Return JSON",
            input_text="Build a card",
            output_schema={"type": "object", "additionalProperties": False},
            model=None,
        )

        self.assertEqual(result, '{"ok":true}')
        self.assertEqual(http.ws_call["url"], chatgpt.OPENAI_CODEX_RESPONSES_WS_URL)
        self.assertEqual(http.call["url"], chatgpt.OPENAI_CODEX_RESPONSES_URL)
        self.assertEqual(http.call["headers"]["chatgpt-account-id"], "acct-test")
        self.assertNotIn("tools", http.call["json"])
        self.assertFalse(http.call["json"]["store"])
        self.assertTrue(http.call["json"]["stream"])
        self.assertEqual(http.call["json"]["model"], "gpt-5.6-sol")

    async def test_websocket_generation_uses_response_create_protocol(self):
        websocket = FakeWebSocket(
            [
                FakeWebSocketMessage(
                    '{"type":"response.output_text.delta","delta":"{\\"ok\\":true}"}'
                ),
                FakeWebSocketMessage(
                    '{"type":"response.completed","response":{"output":[]}}'
                ),
            ]
        )
        http = FakeHttpSession(FakeResponse(b""), websocket=websocket)
        chatgpt.async_get_clientsession = lambda hass: http
        session = chatgpt.ChatGptSession(FakeHass())
        session._credentials_loaded = True
        session._credentials = chatgpt._Credentials(
            access=fake_access_token(),
            refresh="refresh-token",
            expires=int(time.time() * 1000) + 3600_000,
            account_id="acct-test",
            plan_type="plus",
        )

        result = await session.async_generate_structured(
            developer_instructions="Return JSON",
            input_text="Build a card",
            output_schema={"type": "object", "additionalProperties": False},
            model="gpt-5.5",
        )

        self.assertEqual(result, '{"ok":true}')
        self.assertIsNone(http.call)
        self.assertEqual(websocket.sent["type"], "response.create")
        self.assertEqual(websocket.sent["model"], "gpt-5.5")
        self.assertEqual(
            http.ws_call["headers"]["OpenAI-Beta"],
            "responses_websockets=2026-02-06",
        )

    async def test_sse_error_is_not_treated_as_output(self):
        response = FakeResponse(
            b'data: {"type":"error","error":{"message":"bad request"}}\n\n'
        )

        with self.assertRaisesRegex(chatgpt.ChatGptSessionError, "bad request"):
            await chatgpt._read_sse_output(response)

    async def test_limited_response_reads_all_network_fragments(self):
        response = FakeResponse(b"", content_type="application/json")
        response.content = FragmentedContent([b'{"device_', b'auth_id":"abc"}'])

        result = await chatgpt._read_limited_response(response, 64)

        self.assertEqual(result, '{"device_auth_id":"abc"}')

    async def test_limited_response_rejects_oversized_body(self):
        response = FakeResponse(b"", content_type="application/json")
        response.content = FragmentedContent([b"1234", b"5"])

        with self.assertRaisesRegex(chatgpt.ChatGptSessionError, "allowed size"):
            await chatgpt._read_limited_response(response, 4)


if __name__ == "__main__":
    unittest.main()
