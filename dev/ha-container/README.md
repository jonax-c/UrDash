# Disposable Home Assistant Validation

This directory runs a throwaway Home Assistant container for validating UrDash against a real Home Assistant frontend without restarting an online Home Assistant instance.

## Requirements

- Docker Desktop, Docker Engine, or another runtime that supports `docker compose`.
- Network access to pull `ghcr.io/home-assistant/home-assistant:stable`.

## Start

From this directory:

```sh
docker compose up
```

Open:

```text
http://localhost:8123
```

Complete Home Assistant onboarding with a throwaway local user.

## Add UrDash

1. Go to **Settings > Devices & services > Add integration**.
2. Search for **UrDash**.
3. Add any dummy API key, for example `validation-only`.

The validation fixture does not call the AI provider, so the key does not need to be valid.

## Validate Preview Rendering

Open:

```text
http://localhost:8123/urdash?urdash_validation=preview
```

Expected result:

- The UrDash panel loads.
- A built-in `urdash_schema: 2` validation card is loaded.
- The preview area renders the card with the real `urdash-card` custom element.
- The card shows a composed v2 layout with text, value cluster, action buttons, and timeline primitives.
- Browser console has no red errors from `urdash-panel.js` or `urdash-custom-card.js`.

This validates the UrDash v2 renderer inside a real Home Assistant frontend session. It does not validate OpenAI generation.

## Stop And Reset

Stop the container:

```sh
docker compose down
```

To reset onboarding and HA storage, remove the generated files under `dev/ha-container/config` except `configuration.yaml`.
