# UrDash v2 Static Demo

This demo renders UrDash v2 cards without Home Assistant.

It provides:

- A mocked `hass` object with sample entity states.
- A minimal `ha-icon` custom element shim.
- Several `urdash_schema: 2` sample cards.
- Direct loading of the real `custom_components/urdash/frontend/urdash-custom-card.js` renderer.

Start from the repository root:

```sh
python3 -m http.server 8765
```

Open:

```text
http://localhost:8765/dev/demo/
```

This validates renderer composition and visual layout only. It does not validate Home Assistant service calls, Home Assistant frontend APIs, or OpenAI generation.
