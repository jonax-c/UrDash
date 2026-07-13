# UrDash Card Spec v2

UrDash Card Spec v2 defines a safe declarative UI language for AI-generated Home Assistant cards.

The goal is to let AI create highly customized, useful, visually distinctive Lovelace custom cards without generating arbitrary JavaScript, HTML, or CSS.

v2 intentionally does not preserve compatibility with the current v1 typed-card format. The current project is still early enough that v2 can become the primary format.

## Design Goals

- Generate reusable Lovelace cards, not only full dashboards.
- Support cards that combine multiple device functions into one task-oriented surface.
- Give AI layout freedom beyond predefined `climate`, `weather`, or `room` card templates.
- Keep rendering deterministic, secure, and debuggable.
- Make cards useful first, beautiful second, and decorative only when it supports usability.
- Support subtle custom animations without allowing AI-authored code.

## Non-Goals

- AI-generated JavaScript.
- AI-generated raw HTML.
- AI-generated raw CSS or `@keyframes`.
- External scripts or untrusted assets.
- Full replacement of Home Assistant dashboards/routes.
- Backward compatibility with v1 card specs.

## Top-Level Lovelace Shape

Generated cards should be pasted into Lovelace as:

```yaml
type: custom:urdash-card
urdash_schema: 2
height_mode: auto
card:
  intent:
    goal: room_control
    title: Living Room
    risk_level: medium
    primary_entities:
      - climate.living_room_ac
      - light.living_room_main
  layout:
    type: grid
    columns: 12
    blocks: []
```

Supported `height_mode` values:

- `auto`: natural Lovelace card height.
- `viewport`: immersive card, at least most of the viewport height.
- `fixed`: fixed-height card with internal scrolling.

For `fixed`, the card may include:

```yaml
height: 720
```

## AI Design Process

Before producing blocks, the AI must decide:

1. What is the user's task?
2. What state must be visible immediately?
3. What actions should be one-tap?
4. What secondary context supports those actions?
5. Which actions are risky?
6. What layout best supports the task?

The output should reflect that design thinking through `intent`, not through prose.

```yaml
intent:
  goal: climate_control
  title: Living Room Climate
  summary: Control comfort quickly without opening a full dashboard.
  risk_level: low
  primary_entities:
    - climate.living_room_ac
  primary_actions:
    - climate.set_temperature
    - climate.set_hvac_mode
```

## Intent

`intent` tells UrDash what the card is for.

```yaml
intent:
  goal: room_control
  title: Living Room
  summary: Combined comfort, lighting, cover, and occupancy controls.
  risk_level: medium
  primary_entities:
    - light.living_room_main
    - climate.living_room_ac
  primary_actions:
    - light.toggle
    - climate.set_temperature
```

Recommended `goal` values:

- `sensor_summary`
- `weather`
- `room_control`
- `climate_control`
- `security`
- `energy`
- `hero_visual`
- `scene_launcher`
- `media_control`
- `multi_device_control`

`risk_level` values:

- `low`
- `medium`
- `high`

High-risk cards can render normally, but high-risk actions must require confirmation.

## Entity Capability Context

Before generation, UrDash normalizes every selected Home Assistant entity into a
versioned `EntityCapabilityDescriptor`. This is generation context, not card YAML.

```json
{
  "capability_schema": 1,
  "entity_id": "light.lounge",
  "domain": "light",
  "name": "Lounge",
  "state": "on",
  "available": true,
  "device_id": "device-1",
  "area_id": "living_room",
  "supported_features": 0,
  "display": { "brightness": 180 },
  "capabilities": [
    {
      "id": "turn_on",
      "service": "light.turn_on",
      "risk": "low",
      "parameters": {
        "brightness_pct": { "type": "number", "min": 0, "max": 100, "step": 1, "unit": "%" }
      }
    }
  ]
}
```

Descriptors are derived from entity state, attributes, `supported_features`,
registry metadata, and the currently registered Home Assistant services. They let
AI design controls from actual device capabilities instead of guessing from an
entity domain.

The capability list describes what a device can do. The Action Policy separately
defines which of those operations the current UrDash runtime may execute. An AI
generated action must satisfy both layers.

## Layout Models

v2 supports two safe layout models.

`layout.chrome` may be `normal` or `art`. Use `art` only when the generated vector/canvas artwork is the entire card surface and the card should render without the normal header chrome.

### Grid Layout

Grid layout is the default and should handle most cards.

```yaml
layout:
  type: grid
  columns: 12
  density: comfortable
  blocks:
    - id: current_temp
      kind: value
      grid:
        col: 1
        row: 1
        w: 4
        h: 2
```

Allowed `density` values:

- `compact`
- `comfortable`
- `spacious`

Grid constraints:

- `columns` must be between `4` and `16`.
- `col`, `row`, `w`, and `h` must be positive integers.
- Blocks must be clamped to the grid.
- Renderer may reflow for mobile.

### Canvas Layout

Canvas layout is for highly visual cards.

```yaml
layout:
  type: canvas
  aspect_ratio: "16/9"
  responsive:
    mobile:
      aspect_ratio: "4/5"
  density: calm
  blocks:
    - id: home_pulse
      kind: radial_meter
      frame:
        x: 8
        y: 12
        w: 38
        h: 42
      responsive:
        mobile:
          frame:
            x: 6
            y: 10
            w: 88
            h: 38
```

Canvas constraints:

- `x`, `y`, `w`, and `h` are percentages.
- Values must be numeric and clamped from `0` to `100`.
- Blocks cannot use raw CSS positioning strings.
- Canvas cards automatically switch to a taller mobile aspect ratio on narrow cards.
- AI may set `layout.responsive.mobile.aspect_ratio` when the mobile composition needs a specific shape.
- Blocks may set `responsive.mobile.frame` to move or resize a block on mobile.
- Keep mobile canvas layouts readable at about 350px wide.
- Prefer fewer, larger focal elements on mobile rather than shrinking a dense desktop composition.

## Blocks

Blocks are safe UI primitives. AI composes these primitives to create different card forms.

Every block has:

```yaml
- id: unique_block_id
  kind: value
  title: Current
  entity: sensor.living_room_temperature
```

Common fields:

- `id`: stable block identifier.
- `kind`: primitive type.
- `title`: optional visible title.
- `subtitle`: optional supporting text.
- `entity`: optional primary entity.
- `entities`: optional entity list.
- `bind`: optional entity binding.
- `grid` or `frame`: layout placement.
- `style`: safe style tokens.
- `presentation`: safe surface and composition tokens.
- `animation`: safe animation declaration.
- `visibility`: optional conditional display.

For relationship, topology, and flow-based cards, AI should use `visual_map` instead of requesting a predefined layout. The AI owns node placement and link design; the renderer only safely draws the declared map.

## Presentation

`presentation` tells the renderer how a block should feel visually. It is not raw CSS.

```yaml
presentation:
  surface: floating
  scale: large
  align: center
  layer: raised
```

Allowed `surface` values:

- `panel`: normal contained surface.
- `glass`: translucent elevated surface.
- `ghost`: lightly framed or transparent surface.
- `naked`: no panel frame; content sits directly in the composition.
- `hero`: large focal surface.
- `floating`: compact floating command surface.
- `orb`: circular surface.
- `strip`: pill-shaped horizontal strip.
- `rail`: framed command rail.

Allowed `scale` values:

- `micro`
- `small`
- `normal`
- `large`
- `xl`
- `full`

Allowed `align` values:

- `start`
- `center`
- `end`
- `stretch`

Allowed `layer` values:

- `backdrop`
- `base`
- `raised`
- `overlay`

AI should use `presentation` to avoid defaulting every block to a card-like panel. Fancy cards should usually combine one or two focal blocks, ambient or spatial background blocks, and compact controls.

## Primitive Types

### Text

```yaml
kind: text
text: Living room is comfortable
variant: headline
```

Variants:

- `label`
- `body`
- `headline`
- `display`
- `title`
- `caption`

### Icon

```yaml
kind: icon
icon: mdi:sofa
tone: calm
```

### Vector Icon

`vector_icon` lets AI create a custom SVG-like symbol without raw SVG markup. The renderer safely rebuilds each shape with DOM APIs.

```yaml
kind: vector_icon
label: Solar cloud
viewBox: "0 0 100 100"
gradients:
  - id: sky_glow
    type: radial
    center: { x: 50, y: 45 }
    radius: 60
    stops:
      - offset: 0
        color: accent
        opacity: 0.9
      - offset: 1
        color: muted
        opacity: 0.1
shapes:
  - type: circle
    cx: 68
    cy: 30
    r: 14
    fill: gradient:sky_glow
    stroke: none
    opacity: 0.35
  - type: path
    d: "M20 62 C26 46, 44 46, 50 58 C56 49, 76 52, 80 66 C74 74, 28 74, 20 62"
    fill: none
    stroke: accent
    stroke_width: 6
  - type: line
    x1: 24
    y1: 84
    x2: 76
    y2: 84
    stroke: muted
    stroke_width: 4
    animation:
      preset: dash_flow
      speed: slow
      intensity: subtle
```

Allowed shapes:

- `path`
- `circle`
- `ellipse`
- `rect`
- `line`
- `polyline`
- `group`

Safety rules:

- No raw SVG, HTML, JavaScript, event handlers, `foreignObject`, images, filters, external references, or CSS.
- Shape coordinates default to a safe 0-100 drawing space.
- `vector_icon` and individual shapes may set `coordinate_mode: number` to use the icon `viewBox` coordinate space with viewBox-aware clamps. This is intended for design-tool-style exports such as `viewBox: "0 0 900 900"`.
- Gradients normally use percent-style coordinates. For design-tool-style exports, gradients may set `coordinate_mode: number` to use clamped raw numeric gradient coordinates (`-5000` to `5000`) with matrix transforms.
- Gradients using `userSpaceOnUse` may place centers, focal points, and endpoints slightly outside the drawing space (`-200` to `300`) for soft off-canvas glows when using the default percent coordinate mode.
- Path data is length-limited and only supports normal SVG path commands and numeric values.
- Paint values are safe tokens: `none`, `accent`, `foreground`, `muted`, safe hex colors, or `gradient:<id>`.
- Gradients are declarative only. Allowed gradient types are `linear` and `radial`.
- Each vector icon may define up to 8 gradients, each with up to 8 stops.
- `render_budget: art` raises vector limits to 24 gradients, 16 stops, 120 top-level shapes, longer paths, and deeper groups for high-fidelity artwork.
- Gradient IDs must use safe identifier characters and are automatically prefixed by the renderer.
- Gradient stop colors may be `accent`, `foreground`, `muted`, or safe hex colors.
- Shapes and gradients may use a safe declarative `transform` with clamped `rotate`, `scale`, `scale_x`, `scale_y`, `translate_x`, `translate_y`, `skew_x`, `skew_y`, `origin`, and a numeric SVG-style `matrix` (`a`/`b`/`c`/`d` clamped to `-4..4`, `e`/`f` clamped by the current viewBox budget).
- For precise imported artwork, `transform.transforms` may contain an ordered list of safe transform steps: `matrix`, `translate`, `rotate`, `scale`, `skew_x`, and `skew_y`. This preserves transform order without allowing raw transform strings.
- Gradients may use safe `units`, `coordinate_mode`, `spread_method`, `focal`, `fx`, `fy`, and `fr` fields.
- Shapes may use safe `blend_mode` values: `normal`, `screen`, `plus-lighter`, `soft-light`, `overlay`, `color-dodge`, `hard-light`, or `lighten`.
- Shapes may use safe `effects.blur`, `effects.brightness`, `effects.saturate`, `effects.glow`, and `effects.neon_glow`; the renderer clamps all values and does not accept raw filter strings.
- Shapes may use safe `effects.filter_preset`: `soft_blur`, `outer_glow`, `inner_glow`, `bloom`, `colored_shadow`, `luminous_ring`, `svg_blur`, or `svg_white_neon`. The `svg_*` presets generate fixed native SVG filter nodes with clamped parameters; raw filter graphs are still not allowed.
- Shapes may use safe `stroke_dasharray` values for controlled dashed strokes and flow effects.
- Shape animations may set a safe `origin` so rotation/orbit effects can use an artwork-level center instead of the shape bounding box.
- `group` may contain child shapes and can receive the same transform/effects/animation fields. Nested groups are intentionally shallow.

Shape animations are optional and declarative:

```yaml
animation:
  preset: rain_drop
  delay: 0.2
  speed: normal
  intensity: subtle
```

Allowed shape animation presets:

- `pulse`
- `breathe`
- `spin`
- `orbit`
- `rain_drop`
- `drift`
- `dash_flow`
- `draw`
- `twinkle`
- `fade`
- `shimmer`

The renderer maps these presets to built-in CSS or safe native SVG animation primitives. AI must not output raw CSS, raw SVG `<animate>`, JavaScript, or unrestricted custom keyframes.

Vector shapes may also use safe keyframe animation. UrDash converts the declaration into bounded `<animate>` / `<animateTransform>` nodes:

```yaml
animation:
  property: rotate
  duration: 10
  phase_offset: 2
  repeat: true
  easing: linear
  origin: { x: 450, y: 450 }
  keyframes:
    - offset: 0
      rotate: 0
    - offset: 1
      rotate: 360
```

Allowed keyframe properties are `opacity`, `rotate`, `scale`, and `translate`.

### Value

Shows one entity state or attribute.

```yaml
kind: value
entity: sensor.living_room_temperature
bind:
  value: state
  unit: attributes.unit_of_measurement
label: Temperature
```

### Value Cluster

Shows multiple compact values.

```yaml
kind: value_cluster
items:
  - entity: sensor.living_room_temperature
    label: Temp
    value: state
  - entity: sensor.living_room_humidity
    label: Humidity
    value: state
```

### Entity List

```yaml
kind: entity_list
entities:
  - binary_sensor.front_door
  - lock.front_door
  - binary_sensor.living_room_motion
```

### Button

```yaml
kind: button
label: Toggle main light
icon: mdi:lightbulb
action:
  type: service
  domain: light
  service: toggle
  entity_id: light.living_room_main
```

### Button Group

```yaml
kind: button_group
buttons:
  - label: Movie
    action:
      type: service
      domain: scene
      service: turn_on
      entity_id: scene.living_room_movie
  - label: Bright
    action:
      type: service
      domain: light
      service: turn_on
      entity_id: light.living_room_main
      data:
        brightness_pct: 100
```

### Toggle Group

```yaml
kind: toggle_group
entities:
  - light.living_room_main
  - switch.living_room_fan
```

Renderer chooses the correct low-risk service for each entity.

### Segmented Control

```yaml
kind: segmented_control
entity: climate.living_room_ac
options:
  - label: Cool
    value: cool
  - label: Dry
    value: dry
  - label: Off
    value: "off"
action:
  type: service
  domain: climate
  service: set_hvac_mode
  data:
    hvac_mode: "$selected"
```

### Slider

```yaml
kind: slider
entity: light.living_room_main
bind:
  value: attributes.brightness
range:
  min: 0
  max: 255
  step: 5
action:
  type: service
  domain: light
  service: turn_on
  data:
    brightness: "$value"
```

### Climate Control

```yaml
kind: climate_control
entity: climate.living_room_ac
features:
  - current_temperature
  - target_temperature
  - hvac_modes
  - fan_modes
```

Renderer provides:

- Current temperature.
- Target temperature.
- Increase/decrease controls.
- HVAC mode buttons.
- Optional fan mode controls.

### Cover Control

```yaml
kind: cover_control
entity: cover.living_room_curtain
features:
  - open
  - close
  - stop
  - position
```

### Security Cluster

```yaml
kind: security_cluster
entities:
  - lock.front_door
  - binary_sensor.front_door
  - binary_sensor.living_room_motion
```

Renderer highlights attention states:

- `open`
- `unlocked`
- `on`
- `detected`
- `triggered`
- `unavailable`

### Scene Strip

```yaml
kind: scene_strip
actions:
  - label: Morning
    entity_id: scene.home_morning
  - label: Night
    entity_id: scene.home_night
```

### Gauge

```yaml
kind: gauge
entity: sensor.battery_level
bind:
  value: state
range:
  min: 0
  max: 100
```

### Radial Meter

```yaml
kind: radial_meter
entity: sensor.home_power
bind:
  value: state
range:
  min: 0
  max: 5000
```

### Timeline

```yaml
kind: timeline
entities:
  - binary_sensor.front_door
  - lock.front_door
  - binary_sensor.motion_hallway
```

### Sparkline

Sparkline is allowed as a visual primitive, but v2 renderer may initially show a placeholder until history data support exists.

```yaml
kind: sparkline
entity: sensor.energy_today
range:
  hours: 12
```

### Divider

```yaml
kind: divider
```

### Chip Group

```yaml
kind: chip_group
chips:
  - label: Secure
    entity: lock.front_door
  - label: Motion
    entity: binary_sensor.living_room_motion
```

### Hero Value

Large focal state readout.

```yaml
kind: hero_value
entity: sensor.living_room_temperature
bind:
  value: state
  unit: attributes.unit_of_measurement
label: Current comfort
presentation:
  surface: naked
  scale: xl
  align: center
```

### Ambient

Non-interactive visual depth layer. It should support useful content, not replace it.

```yaml
kind: ambient
title: Living Room
subtitle: spatial control layer
icon: mdi:creation
presentation:
  surface: naked
  layer: backdrop
```

### Entity Orbit

Spatial entity summary around a center signal.

```yaml
kind: entity_orbit
entity: sensor.living_room_temperature
entities:
  - sensor.living_room_humidity
  - light.living_room_main
  - cover.living_room_curtain
presentation:
  surface: ghost
```

### Constellation

Free-form compact entity cluster.

```yaml
kind: constellation
title: Room signals
entities:
  - light.living_room_main
  - binary_sensor.hall_motion
  - sensor.living_room_air_quality
```

### Radial Scene

Scene launcher arranged around a central mode label.

```yaml
kind: radial_scene
title: Modes
icon: mdi:palette
actions:
  - label: Movie
    entity_id: scene.living_room_movie
  - label: Night
    entity_id: scene.home_night
```

### Visual Map

AI-designed node/link composition for flows, relationships, topology, spatial control, energy movement, irrigation paths, security perimeters, HVAC air movement, and similar cards.

`visual_map` has no predefined layout. AI chooses node positions, sizes, icons, labels, node stats, link routes, link anchors, path points, animation, and actions based on the user request and available entities.

```yaml
kind: visual_map
nodes:
  - id: solar
    label: Solar
    entity: sensor.solar_power
    icon: mdi:solar-power
    # Or use vector_icon for a safe custom SVG-like node icon.
    # vector_icon:
    #   viewBox: "0 0 100 100"
    #   shapes:
    #     - type: circle
    #       cx: 50
    #       cy: 50
    #       r: 22
    #       fill: none
    #       stroke: accent
    #       stroke_width: 5
    size: large
    position: { x: 18, y: 24 }
    stats:
      - entity: sensor.solar_export
        prefix: "↘ "
        tone: positive
    style:
      accent: "#d9a441"
      shape: ring
      ring_width: normal
    action:
      type: more_info
      entity_id: sensor.solar_power
  - id: home
    label: Home Load
    entity: sensor.home_power
    icon: mdi:home-lightning-bolt
    size: hero
    position: { x: 54, y: 52 }
    style:
      accent: "#62b488"
      shape: core
links:
  - from: solar
    to: home
    from_anchor: bottom
    to_anchor: left
    label: solar
    show_label: true
    entity: sensor.solar_power
    path:
      points:
        - { x: 38, y: 48 }
        - { x: 48, y: 48 }
    flow_position: { x: 44, y: 48 }
    style:
      accent: "#d9a441"
      width: dynamic
      curve: soft
      animated: true
      direction: forward
      flow_dot: true
```

Useful visual map features:

- `nodes[].style.shape: ring`: circular outline node for market-style energy, water, gas, battery, network, or room topology displays.
- `nodes[].vector_icon`: optional safe custom vector icon for the node, using the same `vector_icon` shape rules.
- `nodes[].stats[]`: secondary readings inside a node, such as import/export, charge/discharge, or auxiliary sensor values.
- `links[].from_anchor` / `to_anchor`: connect from `top`, `right`, `bottom`, `left`, corners, or `center`.
- `links[].path.points[]`: manually route a line through safe percent coordinates.
- `links[].style.flow_dot`: add a moving or static dot on a link to show flow.
- `links[].flow_position`: manually place the flow dot when the route needs a precise visual point.
- `links[].show_label: false`: keep topology clean when the line color and node stats already explain the connection.

Safety constraints:

- Node positions are clamped to the card bounds.
- Link path points are clamped to the card bounds.
- Links can only connect declared node IDs.
- Icons remain declarative `mdi:*` references.
- Actions use the normal UrDash action allowlist.
- Styles and animations are tokens, not raw CSS or JavaScript.

## Multi-Function Cards

Cards can combine multiple device functions in one card. This is expected and encouraged.

Example:

```yaml
type: custom:urdash-card
urdash_schema: 2
height_mode: viewport
card:
  intent:
    goal: room_control
    title: Living Room
    summary: Comfort, lighting, covers, and occupancy in one card.
    risk_level: medium
    primary_entities:
      - climate.living_room_ac
      - light.living_room_main
      - cover.living_room_curtain
      - binary_sensor.living_room_motion
    primary_actions:
      - climate.set_temperature
      - light.toggle
      - cover.open_cover
      - cover.close_cover
  layout:
    type: grid
    columns: 12
    density: comfortable
    blocks:
      - id: room_summary
        kind: value_cluster
        title: Living Room
        grid: { col: 1, row: 1, w: 5, h: 2 }
        items:
          - entity: sensor.living_room_temperature
            label: Temp
            value: state
          - entity: sensor.living_room_humidity
            label: Humidity
            value: state
          - entity: binary_sensor.living_room_motion
            label: Motion
            value: state

      - id: climate
        kind: climate_control
        entity: climate.living_room_ac
        grid: { col: 6, row: 1, w: 7, h: 3 }

      - id: lights
        kind: toggle_group
        title: Lights
        grid: { col: 1, row: 3, w: 4, h: 2 }
        entities:
          - light.living_room_main
          - light.living_room_lamp

      - id: curtains
        kind: cover_control
        entity: cover.living_room_curtain
        grid: { col: 5, row: 4, w: 4, h: 2 }

      - id: scenes
        kind: scene_strip
        title: Scenes
        grid: { col: 9, row: 4, w: 4, h: 2 }
        actions:
          - label: Movie
            entity_id: scene.living_room_movie
          - label: Night
            entity_id: scene.living_room_night
```

## Entity Binding

Bindings read HA state safely. They accept either a legacy binding path or a
bounded declarative expression AST. No expression source code is executed.

Allowed binding sources:

- `state`
- `attributes.<name>`
- `attributes.<nested.path>`
- `last_changed`
- `last_updated`

Example:

```yaml
bind:
  value: attributes.current_temperature
  label: state
```

For derived values, `bind.value` and `bind.unit` can contain an expression. A
missing entity, unavailable nested path, invalid conversion, divide by zero, or
exhausted budget resolves to `null`; display primitives render their normal
missing-value fallback.

Invalid:

```yaml
bind:
  value: "(() => alert('no'))()"
```

## Action Policy

Actions are declarative. UrDash interprets them.

```yaml
action:
  type: service
  domain: climate
  service: set_temperature
  entity_id: climate.living_room_ac
  data:
    temperature: "$current + 1"
```

Allowed action types:

- `service`
- `more_info`
- `navigate`
- `none`

`navigate` must target internal Home Assistant paths only.

### Action Manifest

The versioned `frontend/action-manifest.json` file is the canonical action
allowlist. Python builds the AI response schema from it, and the custom-card
renderer loads the same file before registering the card.

Each service policy can declare:

- Risk and mandatory confirmation.
- Allowed and required data parameters.
- Parameter types, enum options, lengths, and numeric bounds.
- Required Home Assistant `supported_features` bits.
- Required entity attributes.

The manifest covers lights, switches, fans, climate, covers, locks, scenes,
scripts, media players, selects, numbers, alarms, vacuums, valves, humidifiers,
water heaters, remotes, sirens, timers, updates, lawn mowers, counters, and input
helpers. Adding a Home Assistant service to the registry does not automatically
allow UrDash to invoke it.

Before execution the renderer verifies:

1. The entity exists and is available.
2. The action domain matches the entity domain.
3. The service exists in both the manifest and HA frontend service registry.
4. The entity supports required feature bits and attributes.
5. Every data key, value type, range, and entity-specific option is valid.
6. The action satisfies the effective confirmation policy.

### Risk Levels

Low-risk actions can execute directly:

- Toggle lights.
- Toggle switches.
- Set climate target temperature.
- Set HVAC mode.
- Run non-sensitive scenes.

Medium-risk actions may optionally confirm:

- Open/close covers.
- Run whole-home scene.

High-risk actions must confirm:

- Unlock lock.
- Open garage.
- Disarm alarm.
- Trigger siren or alarm.
- Run a script with unknown side effects.
- Install an update.
- Open a gas or water valve.

Example:

```yaml
confirmation:
  required: true
  text: Unlock front door?
```

Renderer can force confirmation even if AI omits it.

In-flight actions are keyed by domain, service, and entity. Duplicate calls are
collapsed until the first call completes. Controls expose pending, disabled, and
error states, and action errors emit an `urdash-action-error` event.

## Safe Data Expressions

Expressions are JSON/YAML objects with an `op` and operation-specific fields.
They never contain JavaScript, templates, function names, raw property access,
or executable source. Legacy `$selected`, `$value`, `$current`, and bounded
`$current +/- number` action values remain accepted.

```yaml
bind:
  value:
    op: round
    decimals: 1
    args:
      - op: average
        args:
          - op: entity
            entity_id: sensor.living_room_temperature
            path: state
          - op: entity
            entity_id: sensor.bedroom_temperature
            path: state
  unit:
    op: literal
    value: " °C"
```

Sources:

- `literal`: safe string, number, boolean, or null.
- `entity`: `entity_id` plus `state`, timestamps, or a safe nested
  `attributes.*` path.
- `local`: `selected`, `value`, or `current` from a control action.

Operations:

- Arithmetic: `add`, `subtract`, `multiply`, `divide`, `modulo`, `min`, `max`,
  `average`, `sum`, `clamp`, `round`, `percentage`.
- Logic: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not`, `if`,
  `coalesce`.
- Presentation: `map`, `format_number`, `format_datetime`, `format_duration`,
  `relative_time`, `convert_unit`.

`map` uses ordered `{when, value}` cases and an optional default. This supports
safe label, icon, color, and state mapping without arbitrary object lookup.

Expressions are accepted in display text, binding values and units, style
accents, icon selection, visibility, animation activation, visual-map labels
and flow state, and allowlisted action parameters. The renderer tracks every
referenced entity and skips rerenders when unrelated Home Assistant states
change.

Budgets are fixed: at most 8 nested expression levels, 128 operations, 16
arguments per operation, 32 distinct referenced entities, and 1024 output
characters. Unsafe keys such as `constructor`, `prototype`, and `__proto__` are
rejected.

## Weather Forecast Data Source

Forecast cards use the same push subscription as Home Assistant's built-in
weather card. The AI declares a bounded source; the renderer owns the fixed
WebSocket command and subscription lifecycle.

```yaml
card:
  data_sources:
    - id: home_daily
      type: weather_forecast
      entity: weather.home
      forecast_type: daily
      limit: 5
```

Allowed forecast types are `daily`, `hourly`, and `twice_daily`, and the selected
weather entity must advertise the corresponding supported feature. A card may
declare at most four data sources and request at most 16 forecast entries per
source.

Forecast values are read with the safe `source` expression:

```yaml
op: source
source_id: home_daily
path: forecast.0.temperature
```

Safe top-level paths are `status` and `type`. `status` is `loading`, `ready`, or
`error`. Forecast item paths use `forecast.<0-15>.<field>` and allow only the
documented weather fields: date/time, day/night, condition, temperature and low
temperature, apparent temperature, dew point, precipitation, precipitation
probability, humidity, pressure, cloud coverage, UV index, wind bearing, wind
speed, and wind gust speed.

The `concat` operation can compose readings such as `31° / 25°` without raw
templates. `format_datetime` also accepts `weekday_short`, `weekday_long`, and
`time_short` for forecast labels. The renderer subscribes through
`weather/subscribe_forecast`, rerenders on pushed updates, and always
unsubscribes when the card disconnects or its source configuration changes.

## Reusable Icon Sets

Cards can define reusable icon variants once and resolve them from literal or
expression keys. Icon sets are generic assets and are not limited to weather.

```yaml
card:
  assets:
    icon_sets:
      - id: aurora_weather
        variants:
          - key: sunny
            vector_icon:
              viewBox: 0 0 100 100
              shapes: [...]
          - key: rainy
            icon: mdi:weather-rainy
        fallback:
          icon: mdi:weather-cloudy-alert
```

Any supported icon slot can reference the set:

```yaml
icon_ref:
  set: aurora_weather
  key:
    op: source
    source_id: home_daily
    path: forecast.0.condition
```

`icon_ref` is supported by blocks, block headers, buttons, chips, scene actions,
and visual-map nodes. A set may mix MDI names and declarative vector icons. MDI
assets must use the `mdi:` namespace; vector variants pass through the same
shape, gradient, animation, path-data, nesting, and performance validation as
inline vector artwork.

A card may define at most 8 icon sets, 24 variants per set, and 96 variants in
total. Set IDs and variant keys are bounded safe identifiers. References use the
declared fallback when a dynamic key is unknown, and never load external assets.

## Generic Component Tree

`component_tree` is the safe composition primitive for Bubble-style switches and
compound controls. It gives the AI nested layout freedom without exposing DOM,
HTML, CSS, or JavaScript.

Container components:

- `row`, `column`, `wrap`: flex composition.
- `stack`: bounded overlay composition with semantic placement tokens.
- `surface`: optionally pressable row or column surface with keyboard behavior.

Leaf components:

- `text`, `icon`, `value`, `toggle`, `slider`, `button`, `progress`, `divider`,
  and `spacer`.

```yaml
- id: living-light
  kind: component_tree
  component:
    type: surface
    entity: light.living_room
    action:
      type: service
      domain: light
      service: toggle
      entity_id: light.living_room
    style:
      surface: solid
      shape: pill
      accent: "#f6c453"
    layout:
      direction: row
      width: fill
      align: center
      gap: md
      padding: md
    children:
      - type: icon
        icon: mdi:lightbulb-on
      - type: column
        layout: { grow: 1, gap: xs }
        children:
          - type: text
            text: Living room
            style: { emphasis: high }
          - type: value
            entity: light.living_room
      - type: toggle
        entity: light.living_room
        action:
          type: service
          domain: light
          service: toggle
          entity_id: light.living_room
```

Components accept expression-driven text, values, units, icons, icon references,
accent, visibility, and disabled state. Interactive nodes use the existing
allowlisted action manifest. Sliders pass their bounded numeric result through
the local `value` expression and always require an explicit action.

Buttons may set `icon_only: true` to visually hide their label while retaining
it as the accessible name and hover tooltip. Icon-only buttons must declare an
`icon` or `icon_ref`; blank interactive targets are rejected by validation.

Layout is tokenized: direction, gap, padding, alignment, justification, width,
grow, and stack placement. Styling is tokenized through surface, shape, tone,
emphasis, size, opacity, and a validated accent color. Accent inherits through
the tree so compound controls share one state-driven visual language.

Trees are limited to 6 levels, 96 total nodes, and 16 children per container.
Entity references, actions, expressions, icon references, component IDs, ranges,
and leaf/container contracts are validated recursively. Surface, toggle, slider,
and button controls provide keyboard and disabled semantics; child controls do
not accidentally trigger a pressable parent surface.

## Styling

AI can choose style tokens, not raw CSS.

```yaml
style:
  tone: calm
  emphasis: hero
  shape: soft
  density: compact
  accent: teal
```

Allowed tones:

- `neutral`
- `calm`
- `warm`
- `cool`
- `alert`
- `success`

Allowed emphasis:

- `low`
- `normal`
- `high`
- `hero`

Allowed shapes:

- `none`
- `soft`
- `pill`
- `circle`

Accent can be:

- A predefined token such as `teal`, `amber`, `coral`, `graphite`.
- A hex color such as `#1f8a70`.

Renderer may clamp low-contrast colors.

## Themes

Initial themes:

- `aurora`: expressive, spatial, colorful.
- `quiet`: minimalist, sparse, low-distraction.
- `graphite`: darker and higher contrast.
- `calm`: neutral and soft.
- `sunrise`: warmer and brighter.

Themes affect the card surface, typography, spacing, and animations. They do not change action policy.

## Animation

v2 supports animations as declarative presets.

```yaml
animation:
  preset: breathe
  trigger: always
  speed: slow
  intensity: subtle
```

Allowed presets:

- `none`
- `pulse`
- `breathe`
- `glow`
- `float`
- `shimmer`
- `progress`
- `orbit`
- `wave`
- `count_up`
- `state_flash`
- `slide_in`
- `fade_in`

Allowed triggers:

- `always`
- `on_load`
- `on_state_change`
- `state_on`
- `state_alert`
- `on_hover`

Allowed speed:

- `slow`
- `normal`
- `fast`

Allowed intensity:

- `subtle`
- `normal`
- `strong`

No AI-authored keyframes, CSS, or JavaScript are allowed.

For `state_alert`, renderer decides alert state from values like:

- `on`
- `open`
- `unlocked`
- `detected`
- `triggered`
- `unavailable`

## Visibility

Blocks can be conditionally visible.

```yaml
visibility:
  entity: binary_sensor.front_door
  operator: equals
  value: "on"
```

Allowed operators:

- `equals`
- `not_equals`
- `in`
- `not_in`
- `exists`

## Validation Rules

UrDash uses a layered validation pipeline:

1. `CARD_V2_SCHEMA` is the Python source used by AI structured output and backend
   validation.
2. `scripts/export_card_schema.py` generates the compact frontend
   `card-schema-v2.json` artifact from that source.
3. An equality test prevents the generated artifact from becoming stale.
4. Backend semantic compilation validates HA-specific references and capabilities.
5. The custom-card validates pasted YAML against the same artifact before creating
   any DOM.

AI generation uses a strict provider schema. Optional UrDash properties become
required nullable provider fields, then null placeholders are removed before the
canonical schema and semantic compiler run. A failed generation receives one
diagnostic-guided repair attempt.

Diagnostics contain:

- JSON path.
- Stable error code.
- Human-readable message.
- Suggested correction.
- Severity.

Recommended limits:

- Max blocks: `64`
- Max nested container depth: `3`
- Max entities per block: `12`
- Max buttons per group: `8`
- Max sections/containers: `12`
- Max text length per label: `80`
- Max title length: `48`
- Max visual map nodes per block: `48`
- Max visual map links per block: `96`
- Max actions per card: `96`
- Normal vector budget: `48` shapes, `8` gradients, and `600` path characters.
- Art vector budget: `120` shapes, `24` gradients, and `2400` path characters.

Validation must reject or sanitize:

- Raw HTML.
- Script tags.
- Inline event handlers.
- Raw CSS.
- External JS.
- Unknown service calls.
- Entity IDs not present in HA state.
- Non-numeric layout coordinates.
- Unknown block kinds.
- Duplicate block or visual node IDs.
- Visual links referencing missing nodes.
- Invalid entity bindings.
- Actions unsupported by the target entity's feature flags.

`urdash_schema_minor` defaults to `0`. The v2.0 normalizer supplies this value for
older v2 cards, while a renderer rejects future minor versions it does not support.

Renderer should degrade gracefully:

- Unknown block kind -> visible unsupported-block message.
- Missing entity -> visible missing-entity chip.
- Denied action -> disabled button with tooltip/message.

## Renderer Responsibilities

The renderer owns:

- DOM creation.
- CSS classes.
- Animation classes.
- Service call execution.
- Confirmation prompts.
- Entity state binding.
- Responsive layout.
- Validation.
- Fallback UI.

The AI owns:

- Intent.
- Entity selection.
- Block composition.
- Labels.
- Hierarchy.
- Safe style tokens.
- Safe animation declarations.
- Visual map node/link positions and styling.

## Example: Minimal Climate Card

```yaml
type: custom:urdash-card
urdash_schema: 2
height_mode: auto
card:
  intent:
    goal: climate_control
    title: Living Room Climate
    summary: Minimal AC control with current and target temperature.
    risk_level: low
    primary_entities:
      - climate.living_room_ac_daikin
    primary_actions:
      - climate.set_temperature
      - climate.set_hvac_mode
  layout:
    type: grid
    columns: 12
    density: spacious
    theme: quiet
    blocks:
      - id: current
        kind: value
        title: Current
        entity: climate.living_room_ac_daikin
        bind:
          value: attributes.current_temperature
        grid: { col: 1, row: 1, w: 5, h: 2 }
        style:
          emphasis: hero
          tone: cool
        animation:
          preset: breathe
          trigger: always
          speed: slow
          intensity: subtle

      - id: target
        kind: climate_control
        entity: climate.living_room_ac_daikin
        grid: { col: 6, row: 1, w: 7, h: 3 }

      - id: mode
        kind: segmented_control
        entity: climate.living_room_ac_daikin
        grid: { col: 1, row: 3, w: 12, h: 1 }
        options:
          - label: Cool
            value: cool
          - label: Dry
            value: dry
          - label: Fan
            value: fan_only
          - label: Off
            value: "off"
        action:
          type: service
          domain: climate
          service: set_hvac_mode
          entity_id: climate.living_room_ac_daikin
          data:
            hvac_mode: "$selected"
```

## Example: Multi-Function Room Card

```yaml
type: custom:urdash-card
urdash_schema: 2
height_mode: viewport
card:
  intent:
    goal: room_control
    title: Living Room
    summary: Comfort, lights, covers, and scene shortcuts in one card.
    risk_level: medium
    primary_entities:
      - climate.living_room_ac
      - light.living_room_main
      - cover.living_room_curtain
      - sensor.living_room_temperature
    primary_actions:
      - light.toggle
      - climate.set_temperature
      - cover.open_cover
      - cover.close_cover
  layout:
    type: grid
    columns: 12
    density: comfortable
    theme: aurora
    blocks:
      - id: room_health
        kind: value_cluster
        title: Room Health
        grid: { col: 1, row: 1, w: 4, h: 2 }
        items:
          - entity: sensor.living_room_temperature
            label: Temp
            value: state
          - entity: sensor.living_room_humidity
            label: Humidity
            value: state
          - entity: binary_sensor.living_room_motion
            label: Motion
            value: state

      - id: climate
        kind: climate_control
        entity: climate.living_room_ac
        grid: { col: 5, row: 1, w: 4, h: 3 }

      - id: lights
        kind: toggle_group
        title: Lights
        grid: { col: 9, row: 1, w: 4, h: 2 }
        entities:
          - light.living_room_main
          - light.living_room_lamp

      - id: cover
        kind: cover_control
        title: Curtain
        entity: cover.living_room_curtain
        grid: { col: 1, row: 4, w: 4, h: 2 }

      - id: scenes
        kind: scene_strip
        title: Scenes
        grid: { col: 5, row: 4, w: 8, h: 2 }
        actions:
          - label: Movie
            entity_id: scene.living_room_movie
          - label: Reading
            entity_id: scene.living_room_reading
          - label: Night
            entity_id: scene.living_room_night
```

## Implementation Phases

### Phase 1

- Add `urdash_schema: 2` parser.
- Add grid layout.
- Add primitives:
  - `text`
  - `icon`
  - `value`
  - `value_cluster`
  - `button`
  - `button_group`
  - `toggle_group`
  - `entity_list`
  - `divider`
  - `chip_group`

### Phase 2

- Add action policy.
- Add service allowlist.
- Add confirmation system.
- Add live entity binding.
- Add `climate_control`, `cover_control`, `security_cluster`, `scene_strip`.

### Phase 3

- Add animation presets.
- Add `radial_meter`, `timeline`, `sparkline`, and canvas layout.
- Add mobile reflow rules.

### Phase 4

- Make AI generate v2 by default.
- Remove old v1 typed-card generation path.
- Add validation diagnostics in the UrDash panel.
