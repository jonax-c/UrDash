# UrDash v2 Architecture Roadmap

This document tracks the work required to make UrDash a complete, safe,
AI-generated Home Assistant card runtime. Lovelace remains the installation and
hosting surface, while UrDash owns the card's layout, visuals, data binding, and
device interactions.

Last reviewed: 2026-07-10

## Status Legend

- `[ ]` Not started
- `[-]` In progress
- `[x]` Complete
- `[!]` Blocked or requires an architecture decision

## Success Criteria

UrDash v2 is architecture-complete when:

- AI receives an accurate description of every selected entity's capabilities.
- AI can compose responsive cards without relying on predefined device layouts.
- Cards can safely display live, historical, and derived Home Assistant data.
- Cards can invoke all explicitly supported device capabilities with validated
  parameters and appropriate risk controls.
- The same schema and policy definitions drive AI generation, backend validation,
  preview, and the Lovelace renderer.
- Complex cards update incrementally without resetting controls or animations.
- Invalid or unsupported configurations fail safely with actionable diagnostics.

## P0: Capability Model

- [x] Define a versioned `EntityCapabilityDescriptor` schema.
- [x] Include entity, device, area, domain, device class, state, availability, and
  unit metadata.
- [x] Derive capabilities from `supported_features`, entity attributes, and the
  Home Assistant service registry.
- [x] Describe supported action parameters, types, ranges, steps, options, and
  units for each entity.
- [x] Cover light brightness, color temperature, RGB color, and effects.
- [x] Cover fan percentage, direction, oscillation, and presets.
- [x] Cover current Home Assistant climate capabilities: temperature ranges,
  humidity, fan, preset, vertical swing, and horizontal swing.
- [x] Cover cover position, tilt, and device-class-specific behavior.
- [ ] Cover media playback, volume, mute, seek, source, and media selection.
- [x] Cover alarm, vacuum, lock, valve, siren, humidifier, water heater, remote,
  lawn mower, update, timer, button, number, and select domains.
- [x] Replace the fixed 250-entity truncation with explicit selection, grouping,
  pagination, or token-aware summarization.
- [x] Preserve `device_id` and `area_id` in AI context.
- [ ] Add fixtures and tests for representative devices in every supported domain.

Primary implementation area: `custom_components/urdash/ai_client.py` and
`custom_components/urdash/__init__.py`.

## P0: Action Manifest And Policy

- [x] Create one shared, versioned action manifest instead of separate Python and
  JavaScript allowlists.
- [x] Generate the AI action schema and frontend executor policy from the manifest.
- [x] Validate entity existence and entity/service domain compatibility.
- [x] Validate service data keys, types, enum options, and numeric bounds.
- [x] Support capability-specific actions instead of exposing arbitrary services.
- [x] Add actions for all domains covered by the capability model.
- [x] Add parameter support for color, effects, presets, position, tilt, humidity,
  source, seek, mute, fan percentage, and other capability-specific values.
- [x] Define low, medium, and high-risk action categories.
- [x] Require confirmation for unlock, alarm disarm, garage/door opening, siren,
  destructive scripts, and other configured high-risk operations.
- [x] Validate internal navigation paths and reject external or malformed targets.
- [x] Add pending, success, error, timeout, and disabled interaction states.
- [x] Add action debouncing and prevent unintended duplicate service calls.
- [x] Add tests proving denied actions cannot reach `hass.callService`.

Primary implementation area: `custom_components/urdash/ai_client.py` and
`custom_components/urdash/frontend/urdash-custom-card.js`.

## P0: Schema Validation And Compilation

- [x] Make the AI response schema strict after all schema definitions are valid.
- [x] Validate generated configurations server-side before returning YAML.
- [x] Validate manually pasted configurations in the frontend runtime.
- [x] Use one canonical schema source for generation, backend validation, demo,
  preview, and production rendering.
- [x] Add semantic validation for entity references, actions, bindings, layout
  bounds, unique IDs, and feature availability.
- [x] Return diagnostics with a JSON path, error code, and suggested correction.
- [x] Add an AI repair pass for invalid generated configurations.
- [x] Add resource and complexity budgets for blocks, SVG shapes, filters,
  gradients, animations, nodes, links, and expression depth.
- [x] Add schema minor versions and renderer feature negotiation.
- [x] Add migrations for future non-breaking schema revisions.
- [x] Add invalid-config and adversarial-config test suites.

## P0: Safe Data And Expression Engine

- [x] Design a bounded declarative expression AST; never evaluate JavaScript.
- [x] Support state and nested attribute reads with safe missing-value behavior.
- [x] Support constants, entity references, and local control values.
- [x] Support arithmetic, min, max, average, sum, clamp, round, and percentage.
- [x] Support comparisons, boolean operations, conditional values, and coalescing.
- [x] Support enum/state mapping for labels, icons, colors, visibility, and styles.
- [x] Support unit conversion and locale-aware number formatting.
- [x] Support date, time, duration, and relative-time formatting.
- [x] Support multi-entity aggregation and derived values.
- [x] Allow expressions in text, style tokens, icon selection, visibility,
  animation state, progress, and safe action parameters.
- [x] Build a dependency graph so only expressions affected by changed entities
  are reevaluated.
- [x] Enforce operation, nesting, entity-reference, and output-size limits.
- [x] Add deterministic expression tests and malformed-input tests.

## P0: Weather Forecast Data Source

- [x] Expose supported daily, hourly, and twice-daily forecast types to the AI.
- [x] Add a bounded, allowlisted `weather_forecast` source declaration.
- [x] Subscribe through Home Assistant's `weather/subscribe_forecast` API.
- [x] Sanitize forecast events and expose only documented scalar fields.
- [x] Support safe indexed source expressions, forecast status, and date labels.
- [x] Unsubscribe on disconnect and source reconfiguration.
- [x] Add deterministic subscription, expression, capability, and validation tests.
- [x] Add a live forecast demo driven by a mocked Home Assistant subscription.

## P0: Reusable Icon Assets

- [x] Define bounded generic icon sets with MDI and declarative vector variants.
- [x] Resolve icon variants from literal, entity, or data-source expressions.
- [x] Support reusable icons in blocks, buttons, chips, scene actions, and maps.
- [x] Apply vector security and performance budgets to reusable artwork.
- [x] Add fallback behavior, reference validation, and deterministic tests.
- [x] Refactor the live weather demo to reuse one complete condition icon set.

## P1: Generic Scene And Component Tree

- [x] Replace flat-only composition with safe nested containers.
- [ ] Add row, column, stack, wrap, nested grid, overlay, scroll, and aspect-ratio
  containers.
- [ ] Evaluate tabs, carousel, disclosure, modal, and popover primitives with
  accessibility and mobile behavior defined first.
- [ ] Support explicit safe ordering within semantic layers.
- [ ] Support clipping, masks, alignment, gaps, padding, and constrained sizing.
- [ ] Allow vector shapes and visual-map regions to declare bindings, tooltips,
  actions, focus behavior, and hit areas.
- [ ] Allow arbitrary controls to be composed inside visual-map nodes.
- [ ] Retain semantic convenience blocks only as optional macros compiled into the
  generic component tree.
- [ ] Define reusable components and safe repetition over bounded entity lists.
- [x] Add container-depth and child-count limits.

Implemented foundation:

- [x] Add recursive row, column, stack, wrap, and pressable surface containers.
- [x] Add text, icon, value, toggle, slider, button, progress, divider, and spacer.
- [x] Add expression-driven state, style, visibility, disabled state, and actions.
- [x] Add keyboard semantics and prevent nested-control action bubbling.
- [x] Enforce 6-level, 96-node, and 16-child composition budgets.
- [x] Add a responsive compound Bubble-style light-control demo.

## P1: Data Sources And Visualization

- [ ] Add a safe Home Assistant Recorder/history data source.
- [ ] Define time range, sampling, aggregation, gaps, and unavailable-state policy.
- [ ] Replace the decorative sparkline with a real data-series renderer.
- [ ] Replace the current-state timeline with real state-history events.
- [ ] Add line, area, bar, stacked bar, donut, radial, heatmap, and event charts.
- [ ] Add multi-series axes, legends, thresholds, annotations, and tooltips.
- [ ] Add current/live stream support where Home Assistant exposes suitable data.
- [ ] Add bounded caching and cancellation for history requests.
- [ ] Add calendar, todo, schedule, event-log, and table/list data primitives.
- [ ] Add camera/image/media primitives with safe Home Assistant-local sources.
- [ ] Evaluate map and floorplan primitives without allowing untrusted assets.
- [ ] Add empty, loading, stale, unavailable, and error states for every data source.

## P1: Device Interaction Coverage

- [x] Replace fixed climate UI behavior with capability-composed controls.
- [x] Replace fixed cover UI behavior with capability-composed controls.
- [x] Add light controls for brightness, color, temperature, and effects.
- [x] Add fan controls for speed, oscillation, direction, and presets.
- [ ] Add media transport, volume, mute, seek, source, and browsing controls.
- [ ] Add security, alarm, lock, camera, and siren controls with risk policy.
- [ ] Add vacuum, valve, humidifier, water heater, remote, and mower controls.
- [ ] Add generic button, toggle, number, select, text, date, and time controls.
- [ ] Use Home Assistant min/max/step/options instead of hardcoded values.
- [ ] Add optimistic-state policy only where it is safe and reversible.

## P1: Animation Completeness

- [ ] Implement or remove every advertised block animation preset.
- [ ] Implement `shimmer`, `progress`, `orbit`, `wave`, `count_up`, and
  `state_flash` behavior.
- [ ] Implement `on_load`, `on_state_change`, `state_on`, `state_alert`, and
  `on_hover` triggers.
- [ ] Make speed and intensity settings affect actual animation parameters.
- [ ] Support expression-driven animation state without rebuilding SVG trees.
- [ ] Preserve animation continuity across Home Assistant state updates.
- [ ] Apply reduced-motion behavior consistently to block, vector, and flow
  animations.
- [ ] Add frame-time and resource-budget tests for complex animated cards.

## P1: Incremental Renderer

- [ ] Separate config compilation, initial DOM creation, and live state updates.
- [ ] Stop rebuilding the complete Shadow DOM on every `hass` assignment.
- [ ] Track entity dependencies per binding, expression, style, and action.
- [ ] Patch only affected text, attributes, classes, controls, and SVG properties.
- [ ] Preserve focus, slider interaction, scroll position, and animation progress.
- [ ] Await service calls and expose interaction status to the relevant control.
- [ ] Add cleanup for listeners, timers, observers, and in-flight requests.
- [ ] Add performance tests for large cards and rapid state changes.

## P2: Responsive Layout

- [ ] Add container-based mobile, tablet, desktop, and wide breakpoints.
- [ ] Add orientation and compact-height overrides.
- [ ] Support min/max size, aspect ratio, intrinsic sizing, and overflow policy.
- [ ] Define responsive typography tokens without viewport-scaled font sizes.
- [ ] Add touch-target and gesture-safe spacing rules.
- [ ] Test representative cards at narrow mobile, tablet, desktop, and dashboard
  panel dimensions.
- [ ] Add screenshot regression tests for responsive compositions.

## P2: Accessibility And Localization

- [ ] Add declarative labels, descriptions, roles, and live-region policy.
- [ ] Ensure every interaction is keyboard accessible with visible focus states.
- [ ] Add appropriate ARIA behavior for sliders, segmented controls, tabs, dialogs,
  charts, and custom SVG hit regions.
- [ ] Do not rely on color alone for state, warning, or selection.
- [ ] Use Home Assistant translations, locale, number formats, time formats, and
  unit system.
- [ ] Support right-to-left layout where practical.
- [ ] Validate contrast and reduced-motion behavior in each theme.

## P2: AI Generation Quality

- [ ] Give the AI only valid capabilities and actions for selected entities.
- [ ] Separate functional planning from visual composition in the generation flow.
- [ ] Require a control and information hierarchy before generating layout.
- [ ] Require loading, unavailable, error, and risky-action states where relevant.
- [ ] Add design-quality constraints without forcing predefined card layouts.
- [ ] Add schema-aware examples for common capability combinations, not templates
  that the AI copies verbatim.
- [ ] Add a critique/repair stage for usability, responsiveness, and accessibility.
- [ ] Add generation fixtures for room control, energy, weather, climate, media,
  security, irrigation, network, and mixed-device cards.
- [ ] Score generated cards for schema validity, entity correctness, action safety,
  information coverage, and visual regression.

## Next Product Milestone: Generation Console

The product workflow and acceptance criteria are defined in
[`urdash-generation-console-spec.md`](urdash-generation-console-spec.md).

- [ ] Complete the Home Assistant Lovelace storage and permission spike.
- [ ] Add optional style guidance and versioned candidate contracts.
- [ ] Redesign the composer around area/device/entity selection, optional style,
  prompt, and recoverable generation states.
- [ ] Add production-equivalent live preview controls and candidate refinement.
- [x] Implement safe, conflict-aware append installation for storage dashboards.
- [x] Add the dashboard/view target selector, YAML fallback, and success navigation.
- [ ] Validate the complete workflow in disposable Home Assistant across desktop,
  tablet, and mobile viewports.

## P2: Developer Tooling And Release Quality

- [ ] Add a standalone demo harness with simulated Home Assistant capabilities,
  states, services, history, and failures.
- [ ] Add an interactive schema inspector and validation diagnostics panel.
- [ ] Add golden sample cards covering every primitive and capability.
- [ ] Add unit tests for schema, expressions, action policy, and bindings.
- [ ] Add browser tests for rendering, interaction, accessibility, and responsive
  layout.
- [ ] Add screenshot and animation regression tests.
- [ ] Add performance budgets to CI.
- [ ] Document schema extension rules and security review requirements.
- [ ] Document supported domains, capabilities, data sources, and known limits.
- [ ] Add a release checklist for HACS packaging, cache behavior, and Home Assistant
  compatibility.

## Known Implementation Mismatches

- [ ] `style.density` exists in the schema but is not applied by block style classes.
- [ ] Accent token documentation and the renderer's hex-only accent handling do not
  agree.
- [ ] `bind.label` is declared but is not consistently rendered.
- [x] Standalone `vector_icon` generation exposes renderer-supported
  coordinate and performance option.
- [ ] AI vector child shapes and renderer-supported nested groups are not aligned.
- [ ] Several declared animation presets and triggers have no implementation.
- [ ] Timeline and sparkline names currently imply real historical data that they
  do not render.
- [ ] Preview, AI schema, and renderer validation do not yet share one canonical
  schema implementation.

## Recommended Delivery Order

1. Capability model and shared action manifest.
2. Canonical schema, compiler, and runtime validation.
3. Safe expression AST and incremental binding engine.
4. Generic nested component tree and interactive vector regions.
5. History/data sources and real chart primitives.
6. Full device interaction coverage.
7. Animation completion and incremental renderer performance.
8. Responsive, accessibility, localization, and release hardening.

## Progress Log

Add dated entries here when a milestone is started or completed.

- 2026-07-10: Initial architecture audit converted into a trackable roadmap.
- 2026-07-10: Added capability descriptor v1, service-registry filtering, core
  smart-home domain normalization, and explicit selected-entity preservation.
- 2026-07-10: Added action manifest v1, manifest-generated AI action schema,
  capability-aware frontend enforcement, risk confirmation, and duplicate-call
  protection.
- 2026-07-10: Added strict structured output, canonical frontend schema artifact,
  backend semantic compilation, diagnostic repair, schema minor negotiation, and
  adversarial validation tests.
