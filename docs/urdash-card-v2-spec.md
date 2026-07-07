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
- `scene_launcher`
- `media_control`
- `multi_device_control`

`risk_level` values:

- `low`
- `medium`
- `high`

High-risk cards can render normally, but high-risk actions must require confirmation.

## Layout Models

v2 supports two safe layout models.

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
  density: calm
  blocks:
    - id: home_pulse
      kind: radial_meter
      frame:
        x: 8
        y: 12
        w: 38
        h: 42
```

Canvas constraints:

- `x`, `y`, `w`, and `h` are percentages.
- Values must be numeric and clamped from `0` to `100`.
- Blocks cannot use raw CSS positioning strings.
- Renderer may stack blocks on narrow screens.

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
- `animation`: safe animation declaration.
- `visibility`: optional conditional display.

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
- `title`
- `caption`

### Icon

```yaml
kind: icon
icon: mdi:sofa
tone: calm
```

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

Bindings read HA state safely. No arbitrary expressions are allowed.

Allowed binding sources:

- `state`
- `attributes.<name>`
- `last_changed`
- `last_updated`

Example:

```yaml
bind:
  value: attributes.current_temperature
  label: state
```

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

### Service Allowlist

Initial safe allowlist:

```yaml
light:
  - turn_on
  - turn_off
  - toggle
switch:
  - turn_on
  - turn_off
  - toggle
fan:
  - turn_on
  - turn_off
  - toggle
climate:
  - set_temperature
  - set_hvac_mode
cover:
  - open_cover
  - close_cover
  - stop_cover
lock:
  - lock
  - unlock
scene:
  - turn_on
script:
  - turn_on
media_player:
  - media_play_pause
  - volume_set
```

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

Example:

```yaml
confirmation:
  required: true
  text: Unlock front door?
```

Renderer can force confirmation even if AI omits it.

## Safe Data Expressions

Allowed action data values:

- Literal strings.
- Literal numbers.
- Literal booleans.
- `$selected`
- `$value`
- `$current`
- `$current + number`
- `$current - number`

No arbitrary expression language.

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

Renderer must validate before rendering.

Recommended limits:

- Max blocks: `48`
- Max nested container depth: `3`
- Max entities per block: `12`
- Max buttons per group: `8`
- Max sections/containers: `12`
- Max text length per label: `80`
- Max title length: `48`

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

