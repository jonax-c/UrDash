# UrDash v2

![UrDash icon](assets/urdash-icon.png)

UrDash v2 is a HACS-installable Home Assistant custom integration for generating AI-designed Lovelace custom cards.

This branch intentionally drops the legacy dashboard, new-tab, reference-dashboard, and recommended-package modes. The product shape is now focused on one thing: generate safe, beautiful, useful `custom:urdash-card` configurations from a prompt and selected Home Assistant entities.

## What It Does

- Adds a native Home Assistant sidebar panel.
- Lets users describe the card they want.
- Lets users choose exactly which entities the AI may use.
- Generates one `urdash_schema: 2` custom-card config.
- Renders the generated card in the panel with the real UrDash card renderer.
- Provides YAML and JSON output for use in Lovelace.
- Supports task-oriented cards for rooms, sensors, climate, weather, energy, security, scenes, and mixed device control.
- Uses a safe declarative primitive schema instead of AI-generated JavaScript, HTML, or CSS.

The v2 schema is documented in [UrDash Card Spec v2](docs/urdash-card-v2-spec.md).

## Install With HACS

Until UrDash is published as a default HACS repository, add it as a custom repository:

1. Open HACS.
2. Open the three-dot menu and choose **Custom repositories**.
3. Add this repository URL.
4. Select **Integration** as the category.
5. Install **UrDash**.
6. Restart Home Assistant.
7. Go to **Settings -> Devices & services -> Add integration** and add **UrDash**.

After setup, UrDash appears in the sidebar.

## AI Setup

During setup, users enter their own OpenAI API key. The API key is stored in Home Assistant's integration entry and is used only by the Home Assistant backend. It is never sent to the UrDash frontend panel.

Defaults:

- Model: `gpt-5.2`
- Base URL: `https://api.openai.com/v1`
- Theme: `aurora`
- Height mode: `auto`

The base URL can be changed for OpenAI-compatible providers. If the AI request fails or no key is configured, UrDash returns an error instead of generating a fallback.

## Using Generated Cards

Before using generated YAML in Lovelace, add the UrDash card resource:

```text
/urdash/static/urdash-custom-card.js?v=20260707.5
```

Set the resource type to `JavaScript module`.

Generated YAML looks like:

```yaml
type: custom:urdash-card
urdash_schema: 2
height_mode: auto
card:
  intent:
    goal: room_control
    title: Living Room
    summary: Comfort, lighting, and key sensors in one card.
    risk_level: medium
    primary_entities: []
    primary_actions: []
  layout:
    type: grid
    columns: 12
    density: comfortable
    theme: aurora
    blocks: []
```

Paste the YAML into a manual Lovelace card editor.

## Device And Entity Selection

UrDash defaults to using all available Home Assistant entities. Before generation, users can narrow the scope in the **Generation context** panel:

- All entities are selected by default.
- Entities are grouped by Home Assistant device when registry metadata is available.
- Entities without a device are grouped by domain.
- Users can filter, select all, clear all, toggle a whole device group, or toggle individual entities.
- Unselected entities are not sent to the AI provider and should not appear in generated card output.

## v2 Renderer

The renderer accepts only `urdash_schema: 2` cards. It renders safe primitives such as:

- `text`
- `value`
- `value_cluster`
- `button`
- `button_group`
- `toggle_group`
- `segmented_control`
- `slider`
- `climate_control`
- `cover_control`
- `security_cluster`
- `scene_strip`
- `gauge`
- `radial_meter`
- `timeline`
- `chip_group`
- `hero_value`
- `ambient`
- `entity_orbit`
- `constellation`
- `radial_scene`
- `visual_map`

Actions are interpreted by UrDash with a service allowlist and confirmation for risky operations. The AI cannot inject arbitrary frontend code.

## Local Validation

For renderer-only work, use the static demo page. It does not require Home Assistant:

```sh
python3 -m http.server 8765
```

Open:

```text
http://localhost:8765/dev/demo/
```

The static demo mocks `hass`, renders several v2 sample cards, and directly loads the real `urdash-custom-card.js` renderer.

Use `dev/ha-container` to run a disposable Home Assistant container and validate UrDash preview rendering without touching an online Home Assistant instance.

The validation URL is:

```text
http://localhost:8123/urdash?urdash_validation=preview
```

This loads a built-in v2 validation fixture and renders it with the same `urdash-card` renderer used in Lovelace. See `dev/ha-container/README.md` for the full workflow.

## Services

UrDash exposes `urdash.generate_card`. The service generates a v2 UrDash card from the current Home Assistant state registry and fires an `urdash_card_generated` event containing the generated card config and YAML.

Service fields:

- `request`: natural-language card request.
- `theme`: `aurora`, `quiet`, `graphite`, `calm`, or `sunrise`.
- `height_mode`: `auto`, `viewport`, or `fixed`.
- `entity_ids`: optional list of entities UrDash may use. Leave empty to allow all entities.

## Development Layout

```text
custom_components/urdash/
  __init__.py
  config_flow.py
  const.py
  manifest.json
  services.yaml
  frontend/urdash-panel.js
  frontend/urdash-custom-card.js
  translations/en.json
```

This repository is a HACS custom integration, not a Home Assistant add-on. It does not require Home Assistant OS.

## Updating

After updating UrDash through HACS:

1. Restart Home Assistant.
2. Hard-refresh the browser.

UrDash version-tags its frontend panel URL to reduce stale JavaScript cache issues, but a hard refresh is still recommended after frontend changes.
