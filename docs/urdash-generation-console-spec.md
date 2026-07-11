# UrDash Generation Console Product Specification

Status: Planned  
Last updated: 2026-07-11

## Product Goal

The UrDash generation console is a focused Home Assistant workspace for turning a
user's intent and selected devices into one production-ready
`custom:urdash-card`. The complete workflow must happen without copying YAML:

1. Select the Home Assistant devices and entities the card may use.
2. Optionally choose a visual direction, or leave design decisions to the AI.
3. Describe the desired card and behavior in a prompt.
4. Generate, validate, and render the card with live Home Assistant data.
5. Operate the preview using the same controls and safety policy as Lovelace.
6. Refine the result until it is useful and visually satisfactory.
7. Add the card to a selected Lovelace dashboard and view without changing any
   existing cards.

The console is an operational design tool, not a dashboard builder, a YAML editor,
or a marketing page. Success means a user can move from intent to an installed,
working card in one coherent flow.

## Product Principles

- **Device scope is explicit.** The AI receives only the entities the user selects.
- **Design is optional guidance.** A style preset influences visual language but
  never selects a predefined layout. `AI decides` is a first-class option.
- **The preview is real.** It uses the production `urdash-card` renderer, current
  `hass` state, service calls, forecast subscriptions, and action policy.
- **Installation is additive.** The default and initial supported operation appends
  a new card. It never replaces a view or edits an existing card.
- **Generated configuration stays declarative.** The AI cannot emit JavaScript,
  HTML, arbitrary CSS, or unrestricted Home Assistant calls.
- **Failure is recoverable.** Generation, rendering, and installation errors keep
  the draft and last valid candidate intact.

## Primary Experience

### Workspace Layout

Desktop uses a two-pane workspace: a compact composer on the left and a flexible,
unframed preview canvas on the right. Mobile stacks the composer, preview, and
actions without horizontal scrolling. The interface should be quiet, dense, and
work-focused, with no hero area or decorative card nesting.

The primary action changes with context:

- Before generation: `Generate card`.
- After a valid result: `Add to dashboard`.
- Secondary result actions: `Refine`, `Regenerate`, and `View configuration`.

### Device Selection

- Load eligible entities from Home Assistant and select all by default.
- Group entities by area and device while preserving entities without either.
- Support search by friendly name, entity ID, area, device, and domain.
- Provide area/device select-all controls, global select all, and clear selection.
- Show unavailable, read-only, and controllable capability states.
- Keep a compact selected count and allow fast review of the selected subset.
- Require at least one selected entity before generation.
- Send only selected entity metadata, capabilities, and safe actions to the AI.

Large installations must remain responsive through debounced search and list
virtualization or equivalent bounded rendering.

### Style Direction

Style selection is optional and independent from card structure.

- Default: `AI decides`, with no visual preset constraint.
- Presets are visual swatches with a name and concise character, initially based on
  UrDash's supported visual languages such as Aurora, Minimal, Graphite, Calm, and
  Sunrise.
- A preset contributes design tokens and generation guidance, not a layout tree.
- A custom visual-direction field may be added after the preset flow is stable.
- Changing style must not reset the device selection or prompt.

### Prompt And Generation

- Keep one clearly labeled prompt field for function, information, priorities, and
  desired behavior.
- Submit prompt, selected entity IDs, optional style guidance, and height policy as
  one generation draft.
- Show distinct queued, generating, validating, repairing, and failed states.
- Preserve the draft after errors and expose actionable validation diagnostics.
- Return a schema-valid card configuration, YAML, JSON, summary, diagnostics, and
  candidate identifier.
- A refinement prompt uses the current candidate as context and creates a new
  candidate. It must not overwrite earlier candidates in the current session.
- Allow restoring a prior candidate before installation.

### Live Preview

- Mount the actual `urdash-card` custom element and pass the current `hass` object.
- Subscribe to the same entity, forecast, timer, and runtime data used in Lovelace.
- Provide compact viewport controls for narrow column, tablet, and wide preview.
- Keep low-risk controls operational. Medium/high-risk actions use the existing
  confirmation policy and visibly report success or failure.
- Clearly identify that controls are live; preview-only quality labels and
  diagnostics must never be written into installed card configuration.
- Surface configuration errors, unavailable entities, failed subscriptions, and
  failed service calls close to the preview.
- The preview and installed card must produce the same layout at the same width.

### Add To Lovelace

`Add to dashboard` opens a focused target selector:

1. Choose a Lovelace dashboard the current user can access.
2. Choose one of its visible views/tabs.
3. Confirm placement at the end of that view.
4. Review the card title, selected target, and live-control warning.
5. Install and offer `Open dashboard` after success.

Installation rules:

- Re-read the dashboard configuration immediately before writing it.
- Validate and sanitize the candidate again, removing all preview-only fields.
- Append exactly one card to the selected view.
- Use revision/conflict detection so concurrent dashboard edits cannot be lost.
- On any error, leave the stored dashboard configuration unchanged.
- Never overwrite, reorder, or remove existing views or cards.
- Clearly handle missing permission, stale view, unavailable dashboard, and storage
  write failures.
- UI-managed storage dashboards are the first automatic-install target.
- YAML-managed dashboards receive a copyable card configuration and precise target
  guidance until Home Assistant provides a safe supported write path.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| GC-01 | Entity selection defaults to all eligible entities and supports search, grouping, bulk selection, and exclusion. |
| GC-02 | Style can be omitted, selected from presets, and later changed without losing the draft. |
| GC-03 | Generation uses only the selected entities and returns a validated candidate with useful diagnostics. |
| GC-04 | Refinement creates recoverable candidate versions within the current session. |
| GC-05 | Preview uses the production renderer, live state, subscriptions, and real safe actions. |
| GC-06 | Preview supports representative Lovelace widths and responsive validation. |
| GC-07 | Users can select a writable dashboard and visible view, then append the card. |
| GC-08 | Installation is conflict-aware, additive, validated, and non-destructive. |
| GC-09 | Successful installation provides direct navigation to the target view. |
| GC-10 | Draft, selection, and last valid candidate survive recoverable errors and panel rerenders. |

## Safety And Permissions

- The backend remains the authority for available entities, capabilities, action
  manifests, schema validation, and Lovelace writes.
- AI output never determines websocket command names, dashboard identifiers, or
  unrestricted service targets.
- Installation verifies the current Home Assistant user is authorized to modify
  the selected dashboard.
- High-risk operations remain confirmation-gated in preview and after installation.
- A candidate can reference only entities included in its generation scope unless
  the user explicitly regenerates with a different scope.
- Log generation and installation failures without logging API keys or sensitive
  entity attributes.

## Accessibility, Responsiveness, And Performance

- All controls have visible labels, keyboard focus, and logical tab order.
- Touch targets are at least 44 by 44 pixels where space permits.
- Selection, warning, and success states never rely on color alone.
- The console works at 350-pixel width without clipped controls or horizontal
  scrolling.
- Respect Home Assistant locale, theme, reduced-motion preference, and units.
- Avoid rerendering the whole preview for unrelated Home Assistant state changes;
  use dependency tracking already provided by the card runtime.
- Generation and installation always show progress and cannot be submitted twice.

## Proposed Data Contracts

### Generation Draft

```json
{
  "prompt": "Create a compact room control card",
  "selected_entity_ids": ["light.living_room", "climate.living_room"],
  "style": { "mode": "preset", "preset": "aurora" },
  "height_mode": "auto"
}
```

`style.mode` supports `auto` and `preset`; `preset` is omitted in auto mode.

### Candidate

```json
{
  "candidate_id": "generated-id",
  "parent_candidate_id": null,
  "card_config": {},
  "yaml": "type: custom:urdash-card",
  "json": "{}",
  "summary": "Room climate and lighting control",
  "diagnostics": [],
  "selected_entity_ids": [],
  "created_at": "ISO-8601 timestamp"
}
```

### Installation Request

```json
{
  "candidate_id": "generated-id",
  "dashboard_id": "lovelace",
  "view_path": "living-room",
  "placement": "append",
  "expected_revision": "opaque-revision"
}
```

The backend resolves the stored candidate, validates it again, and never accepts an
arbitrary dashboard payload from the browser.

## Implementation Plan

### Phase 0: Home Assistant Storage Spike

- Identify supported Home Assistant websocket/storage APIs for listing dashboards,
  reading visible views, checking write permission, and saving a configuration.
- Verify behavior for the default dashboard, additional storage dashboards,
  YAML-managed dashboards, admin and non-admin users, and concurrent edits.
- Add these scenarios to the disposable Home Assistant container fixtures.
- Finalize the installation transaction and rollback strategy before UI work.

### Phase 1: Contracts And State Model

- Add optional style mode to websocket and service generation schemas.
- Separate style guidance from fixed renderer theme selection in the AI prompt.
- Add generation draft and versioned candidate state to the panel.
- Persist the active draft locally for panel rerenders while avoiding sensitive data.
- Add contract and schema tests.

### Phase 2: Composer Redesign

- Build the responsive two-pane workspace and contextual primary action.
- Replace the flat entity list with searchable area/device/entity selection.
- Add optional visual style swatches with `AI decides` as default.
- Implement generation progress, validation diagnostics, and error recovery.
- Verify keyboard, narrow viewport, large entity registry, and HA theme behavior.

### Phase 3: Production-Equivalent Preview

- Keep one production renderer path for panel preview and Lovelace.
- Add viewport controls, live-operation status, service feedback, and diagnostics.
- Add candidate refinement, regeneration, and restore controls.
- Verify entity updates, forecasts, unavailable states, and risk confirmations in the
  disposable Home Assistant environment.

### Phase 4: Safe Lovelace Installation Backend

- Add commands to list accessible dashboards and visible views with writability.
- Add candidate-backed append installation with authorization, sanitization,
  revision checking, atomic failure behavior, and audit-safe errors.
- Add integration tests proving existing cards and views remain byte-for-byte
  equivalent apart from the one appended card.

### Phase 5: Installation Experience

- Build the dashboard/view target selector and installation confirmation.
- Add YAML-managed fallback, progress, conflict recovery, and success navigation.
- Prevent duplicate submission and clearly retain the candidate after failure.

### Phase 6: End-To-End Validation And Release

- Test desktop, tablet, and mobile flows in the disposable HA container.
- Test real low-, medium-, and high-risk interactions in preview and Lovelace.
- Test multiple dashboards, hidden/inaccessible views, stale revisions, YAML mode,
  API errors, and non-admin permissions.
- Add browser screenshots and interaction regression coverage.
- Update HACS installation and user documentation, then run release/cache checks.

## Acceptance Criteria

- A new session selects all eligible entities and lets the user find and exclude an
  entity without losing other selections.
- A user can generate with `AI decides` or a style preset; neither path forces a
  predefined layout.
- The preview receives live Home Assistant state and its controls perform the same
  actions and confirmations as the installed card.
- Preview and Lovelace output match at equivalent widths.
- A valid candidate can be appended to a selected writable dashboard view without
  copying YAML.
- Existing dashboard views and cards are unchanged after successful installation,
  except for the single appended UrDash card.
- Failed, unauthorized, or conflicting installation attempts cause no dashboard
  mutation and provide a recoverable error.
- Preview-only labels and diagnostics are absent from the installed configuration.
- The complete flow is keyboard operable and usable at 350-pixel width.

## Initial Scope Exclusions

- Replacing or editing an existing Lovelace card.
- Dragging the new card to an exact position before installation.
- Generating or replacing an entire dashboard.
- Automatically writing YAML-managed dashboard files.
- Batch generation or installation of multiple cards.
- Cloud sharing, public templates, and cross-instance candidate synchronization.

