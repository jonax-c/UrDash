# UrDash

![UrDash icon](assets/urdash-icon.png)

UrDash is a HACS-installable Home Assistant custom integration that helps create polished Lovelace dashboards from a natural-language request and the entities already available in Home Assistant.

It adds a native Home Assistant sidebar panel where users can:

- Describe the dashboard they want.
- Analyze current Home Assistant entities.
- Select which devices/entities may be used for generation.
- Generate Lovelace YAML.
- Preview generated views with Home Assistant's real Lovelace renderer.
- Generate a native UrDash AI custom dashboard that is not Lovelace-based.
- Copy the dashboard YAML into a manual Lovelace dashboard.
- Generate a new Lovelace tab/view using an existing dashboard as reference.
- See recommended custom-card packages for richer designs.

## Install With HACS

Until UrDash is published as a default HACS repository, add it as a custom repository:

1. Open HACS.
2. Open the three-dot menu and choose **Custom repositories**.
3. Add this repository URL.
4. Select **Integration** as the category.
5. Install **UrDash**.
6. Restart Home Assistant.
7. Go to **Settings → Devices & services → Add integration** and add **UrDash**.

After setup, UrDash appears in the sidebar.

## AI Setup

During setup, users enter their own OpenAI API key. The API key is stored in Home Assistant's integration entry and is used only by the Home Assistant backend. It is never sent to the UrDash frontend panel.

Defaults:

- Model: `gpt-5.2`
- Base URL: `https://api.openai.com/v1`

The base URL can be changed for OpenAI-compatible providers. If the AI request fails or no key is configured, UrDash returns an error instead of generating a fallback.

## Reference Dashboard Mode

UrDash defaults to a non-destructive workflow for existing dashboards:

1. Select an existing dashboard tab from the reference dropdown.
2. Keep generation mode set to `new tab`.
3. Describe the modification you want.
4. UrDash generates one new Lovelace view/tab.

The reference dropdown only lists UI-managed tabs that are visible to the current Home Assistant user. Hidden tabs, subviews, and UrDash's reserved preview tab are excluded.

The reference dashboard is used only as context for style, structure, and existing view paths. Generating a tab does not write to Home Assistant storage or modify the source dashboard. The generated YAML is a view snippet that can be appended as a new tab after review.

After generation, the panel can append the generated view directly to the default UI-managed Lovelace dashboard with **Add tab**. This action:

- Appends one new view only.
- Searches for an editable UI-managed Lovelace storage file, such as `.storage/lovelace` or `.storage/lovelace.*`.
- Creates a timestamped backup of the selected storage file first.
- Avoids duplicate view paths by adding a numeric suffix.
- Does not support YAML-mode dashboards or non-default dashboards yet.

Reload the Lovelace dashboard if the new tab is not visible immediately.

## Device And Entity Selection

UrDash defaults to using all available Home Assistant entities. Before generation, users can narrow the scope in the **Devices and entities** panel:

- All entities are selected by default.
- Entities are grouped by Home Assistant device when registry metadata is available.
- Entities without a device are grouped by domain.
- Users can filter, select all, clear all, toggle a whole device group, or toggle individual entities.
- Unselected entities are not sent to the AI provider and should not appear in generated Lovelace YAML.

## AI Custom Dashboard Mode

Generation mode **AI custom** gives the AI more layout freedom than Lovelace YAML. Instead of returning Lovelace config, the AI returns a structured UrDash dashboard spec that UrDash renders as a native Home Canvas experience.

This mode:

- Does not generate Lovelace YAML.
- Does not use Home Assistant Lovelace cards.
- Supports non-traditional card types such as orbit, scene, metric, control, and timeline.
- Supports a `quiet` minimalist theme for sparse command-layer dashboards.
- Can be previewed directly in the UrDash panel.
- Cannot be added as a Lovelace tab with **Add tab**.
- Does not execute AI-generated JavaScript.

Use this mode when the goal is a highly customized visual command surface inside UrDash rather than a reusable Lovelace dashboard.

## Real Lovelace Preview

UrDash does not use the old lightweight simulated preview. The panel's **Preview** button renders the generated view directly inside UrDash with Home Assistant's Lovelace card helpers.

The preview action:

- Uses Home Assistant's built-in Lovelace card creation path.
- Uses installed custom cards when the generated YAML references them.
- Renders generated sections or card grids inline in the UrDash panel.
- Does not write to `.storage/lovelace` and does not create a temporary preview tab.

This shows the generated card layout before users decide whether to copy the YAML or use **Add tab**. Some full dashboard chrome and route-level behavior can still differ from an opened Lovelace dashboard, but the cards themselves are rendered by Home Assistant's frontend card system.

## Local Validation

Use `dev/ha-container` to run a disposable Home Assistant container and validate UrDash preview rendering without touching an online Home Assistant instance.

The validation URL is:

```text
http://localhost:8123/urdash?urdash_validation=preview
```

This loads a built-in validation fixture and renders it with Home Assistant's real Lovelace card helpers. See `dev/ha-container/README.md` for the full workflow.

## Recommended Lovelace Cards

UrDash can generate YAML that uses these optional custom cards:

- Mushroom Cards
- Bubble Card
- button-card
- mini-graph-card
- card-mod

HACS integrations cannot declare other HACS frontend cards as hard dependencies. UrDash treats them as dashboard recommendations and can fall back to built-in Home Assistant cards when custom cards are disabled.

The panel checks Home Assistant's configured Lovelace resources and marks recommended packages as:

- `installed` with a green dot when the resource URL is configured.
- `missing` with an orange dot when the resource list was checked but the package was not found.
- `not checked` when Home Assistant's resource storage could not be read.

Missing packages include an **Open in HACS** shortcut that opens the corresponding HACS repository through Home Assistant's HACS redirect flow.

## Services

UrDash also exposes `urdash.generate_dashboard`. The service generates a dashboard draft from the current Home Assistant state registry and fires an `urdash_dashboard_generated` event containing the generated dashboard object and YAML.

Service fields:

- `request`: natural-language dashboard request.
- `style`: `modern`, `minimal`, `glass`, or `compact`.
- `allow_custom_cards`: whether generated YAML may use recommended custom cards.
- `mode`: `new_view` for a new tab, `dashboard` for a full Lovelace dashboard draft, or `custom_dashboard` for a native UrDash-rendered AI custom dashboard.
- `reference_dashboard`: optional existing dashboard YAML used as context only, mainly for service calls.
- `entity_ids`: optional list of entities UrDash may use. Leave empty to allow all entities.

## Development Layout

```text
custom_components/urdash/
  __init__.py
  config_flow.py
  const.py
  dashboard_context.py
  manifest.json
  services.yaml
  frontend/urdash-panel.js
  translations/en.json
```

This repository is now shaped as a HACS custom integration, not a Home Assistant add-on. It does not require Home Assistant OS.

## Updating

After updating UrDash through HACS:

1. Restart Home Assistant.
2. Hard-refresh the browser.

UrDash version-tags its frontend panel URL to reduce stale JavaScript cache issues, but a hard refresh is still recommended after frontend changes.
