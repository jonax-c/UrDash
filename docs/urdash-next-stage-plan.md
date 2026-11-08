# UrDash Next-Stage Product And Architecture Plan

Status: Planned; implementation has not started

Created: 2026-11-08

Basis: Review of the current v2 implementation against the dashboard product goal

## Product Goal

UrDash helps each Home Assistant user turn their needs, devices, and preferences
into a highly customized, attractive, usable dashboard. Users can create a single
control card or a complete dashboard, operate a real preview, refine individual
parts, and publish the result without manually editing YAML.

Cards remain reusable building blocks. Dashboard design adds information hierarchy,
navigation, views, sections, shared visual language, and responsive composition.
The AI chooses the design from the user's requirements and actual device
capabilities; a style selection must never select a fixed device layout.

"Any kind of dashboard" is the product direction, not a claim that every data
source or interaction is already supported. Unsupported requirements must be
identified explicitly rather than represented with invented data or controls.

## Current Baseline

- The console generates exactly one `custom:urdash-card` from a prompt, selected
  entities, and optional visual guidance.
- Declarative components, visual maps, vectors, expressions, icon sets, and
  capability-aware actions provide the rendering foundation.
- Preview uses the production card renderer and live Home Assistant state.
- Weather forecasts are supported; general history and chart data are not.
- Candidates live in a bounded backend memory cache; the console displays one
  result and does not submit the previous candidate during regeneration.
- Generation validates schema and semantics and can request one replacement
  after diagnostics. It does not run a separate functional planner or visual
  evaluation stage.
- Relevant state changes rebuild the card DOM.
- Installation appends one card to a storage dashboard's view-level card list.
  Section placement and dashboard-level publication require additional work.

The existing [card specification](urdash-card-v2-spec.md) remains the current
runtime contract. The [generation console specification](urdash-generation-console-spec.md)
describes the original card workflow. This plan defines the next delivery order;
the [architecture roadmap](urdash-v2-roadmap.md) remains the detailed capability
backlog, whose historical checkboxes are not a fresh implementation audit.

## Architecture Decisions

1. Keep the safe declarative runtime, capability descriptors, action manifest,
   expression engine, reusable assets, and shared preview renderer.
2. Add dashboard planning above the card runtime. Continue using Home Assistant
   and Lovelace as the first hosting and publishing environment.
3. Introduce a project document separately from card YAML. Project history,
   prompts, evaluation reports, and publishing metadata do not belong in installed
   card configuration.
4. Expand generic composition and bounded design tokens. Specialized device blocks
   are optional convenience macros; they must not dictate the generated layout.
5. Keep runtime permissions independent of AI output. Validate every generated
   candidate and resolved action against entity scope and actual capabilities.
6. Improve generated-result quality before expanding decorative SVG features.
7. Keep ChatGPT authentication and the existing lightweight provider transport
   outside this milestone's scope. Browser validation tooling must not introduce
   a mandatory browser or Codex runtime download for integration users.

## Delivery Order

| Stage | Deliverable | Exit Condition |
| --- | --- | --- |
| Foundation | Shared limits and reliable publication boundaries | Accepted content is rendered in full; unsupported targets cannot receive misleading installs. |
| 1 | Persistent projects and targeted refinement | Users can restore and refine a saved design without losing previous versions. |
| 2 | Functional planning and rendered quality evaluation | Generated designs satisfy a functional plan and pass measurable quality checks. |
| 3 | Generic responsive composition and incremental rendering | Related cards share a visual language and preserve interaction during live updates. |
| 4 | Real data providers and visualization | Trends and analytical displays are backed by real, bounded HA data. |
| 5 | Dashboard planning and publication | A user can design, preview, refine, and safely publish a complete dashboard. |

Each stage should ship an independently useful result. Do not wait for complete
dashboard generation to deliver project recovery and refinement.

## Foundation: Reliability Gates

- [ ] Unify backend, schema, and frontend complexity limits. Resolve the current
  64-block validation versus 48-block rendering mismatch; reject over-budget
  content with diagnostics instead of silently dropping it.
- [ ] Make installation target-aware for supported view types. Add explicit section
  selection for Sections views, or clearly reject them until supported. Handle
  other constrained view types according to their placement rules.
- [ ] Review publication concurrency and failure handling. Revision checks must
  guard the complete read/modify/save operation; failure recovery must not
  overwrite a newer dashboard revision.
- [ ] Establish reproducible development dependencies, including `jsonschema`,
  and a documented test command that does not depend on temporary local packages.
- [ ] Add focused regression cases for these failures before enabling larger
  dashboard compositions.

Acceptance: no successfully validated candidate loses content during rendering;
supported installation targets display the installed content; unsupported targets
and concurrent edits fail without changing unrelated content.

## Stage 1: Persistent Projects And Targeted Refinement

This is the immediate implementation milestone.

### Project And Candidate Contracts

- [ ] Define a versioned project contract with project ID, owner, title, brief,
  target surface, allowed entity IDs, device context, visual preferences, target
  viewport profiles, active candidate, and timestamps.
- [ ] Define immutable candidate records containing candidate and parent IDs,
  schema version, generated artifact, functional plan when available, diagnostics,
  evaluation status, creation time, and generation provenance.
- [ ] Persist projects and candidates in HA-managed private storage with bounded
  retention, explicit deletion, and storage migrations.
- [ ] Define permissions for listing, reading, refining, deleting, and publishing
  projects. Candidate IDs alone must not authorize access.
- [ ] Store entity references and useful design context; avoid persisting full
  state histories, secrets, or unnecessary device attributes.

### Console And Generation Changes

- [ ] Add create/open/rename/delete project flows and restore the saved draft,
  entity selection, preferences, and active candidate after refresh or HA restart.
- [ ] Separate `Generate`, `Refine`, and `Regenerate` behavior. Refinement submits
  the current artifact and requested change; regeneration creates a new version.
- [ ] Support selecting a specific card or stable component ID for refinement.
  Begin with selected IDs and change scope before adding direct canvas selection.
- [ ] Produce a validated replacement artifact plus a concise change summary.
  Do not accept arbitrary executable patches from the model.
- [ ] Define locked regions and unchanged-region checks so a local edit cannot
  silently redesign unrelated components or change entity scope.
- [ ] Add candidate history, comparison, restore, and undo/redo through candidate
  selection. Restoring a version does not delete its descendants.
- [ ] Keep the last valid candidate visible and usable when generation, validation,
  preview mounting, cancellation, or provider requests fail.
- [ ] Define generation job IDs, cancellation, and stale-result handling so late
  responses cannot replace a newer active candidate.

Acceptance scenario: generate a weather card, request "keep the design but make
the forecast smaller," compare the change, restore the first version, reload the
browser, and continue refining it. A failed attempt leaves the previous valid
version available. Cross-user project access is denied.

## Stage 2: Functional Planning And Quality Evaluation

Target pipeline:

`Request -> Context -> Functional plan -> Composition -> Validation -> Render -> Evaluation -> Bounded repair -> Candidate`

- [ ] Resolve the request into required information, controls, priorities,
  capability references, data dependencies, interaction states, and missing
  requirements before generating layout. Persist a concise structured plan rather
  than model reasoning traces.
- [ ] Let AI suggest relevant entities within the user's allowed scope; preserve
  explicit entity selection and provide a reviewable way to adjust it.
- [ ] Use the accepted plan as the composition contract. Ask for clarification
  when a missing requirement materially changes the result; otherwise record
  reasonable assumptions and continue.
- [ ] Include the failed artifact, diagnostics, and functional plan in repair
  requests. Bound attempts, elapsed time, and provider usage.
- [ ] Check that essential values are live-bound, advertised controls work,
  unsupported controls are absent, and unavailable/loading/error states exist.
- [ ] Collect render diagnostics at narrow, tablet, and wide container widths:
  overflow, clipping, unintended overlap, unreadable text, focus, accessible names,
  contrast, and touch targets.
- [ ] Treat intentional visual layering separately from obstructed text or hit
  areas. Define severity and blocking criteria for each diagnostic.
- [ ] Add screenshot-based visual critique for hierarchy, density, consistency,
  and aesthetics after deterministic checks. User preferences remain authoritative.
- [ ] Start browser automation in the development evaluation harness. In HA,
  collect bounded preview measurements through the production renderer. Any
  optional screenshot upload for AI critique requires explicit user opt-in.
- [ ] Display functional and visual evaluation separately from schema validity.
  If visual checks are unavailable, label them unevaluated rather than passed.

Acceptance: a schema-valid card with static requested readings, hidden essential
controls, or overlapping forecast text is detected. A bounded repair produces a
new version; failure retains the previous candidate and reports the unmet checks.

## Stage 3: Generic Composition And Runtime Quality

- [ ] Introduce shared, bounded design tokens for typography, colors, spacing,
  density, radii, surfaces, elevation, and motion. Store them at project scope and
  resolve them into self-contained installed card artifacts.
- [ ] Expand the generic component tree with nested grid, overlay, constrained
  sizing, aspect ratio, overflow, and container-based responsive overrides.
- [ ] Add accessible disclosure, tabs, popovers, or dialogs only with defined
  keyboard, focus, and mobile behavior.
- [ ] Unify artwork and controls through generic interactive regions and component
  composition, allowing new spatial interfaces without device-specific templates.
- [ ] Compile configuration into stable nodes and binding dependencies, then patch
  affected values and styles during HA updates instead of replacing the whole DOM.
- [ ] Preserve focus, dragging, scroll position, pending actions, and animation
  continuity. Define consistent cleanup and reduced-motion behavior.
- [ ] Apply budgets per card and per dashboard; compose multiple cards rather than
  increasing individual-card limits to accommodate entire dashboards.

Acceptance: an AI-designed room interface and a visually different energy
interface work at 350px, tablet, and desktop widths. Live state changes preserve
active interaction. Multiple cards share tokens without sharing fixed layouts.

## Stage 4: Real Data And Visualization

- [ ] Establish one bounded provider interface for query/subscription, status,
  cancellation, cache policy, authorization, and cleanup.
- [ ] Implement Recorder/history first, with time ranges, sampling, aggregation,
  units, gaps, point limits, and stale/unavailable behavior.
- [ ] Replace decorative sparkline and current-state timeline behavior with real
  series and state-history primitives, or clearly label/remove unsupported forms.
- [ ] Build line/area and bar charts first; add other chart forms when supported
  by concrete dashboard requests and representative evaluation cases.
- [ ] Add calendar, todo, schedules, and event/list/table sources in follow-up work.
- [ ] Add camera/image/media sources through bounded Home Assistant-authorized
  paths and explicit capability declarations.
- [ ] Make source dependencies visible to planning and validation. Missing history,
  permissions, or services must produce actionable limitations, not sample data.

Acceptance: a generated energy dashboard uses real historical consumption and
units; missing samples appear as gaps. Permission errors and canceled requests do
not leak data or leave active subscriptions behind.

## Stage 5: Dashboard Design And Publication

- [ ] Add a versioned dashboard document with views, sections, card instances,
  shared tokens/assets, navigation, and responsive placement policies. Reference
  reusable cards by stable IDs rather than combining everything into one large card.
- [ ] Extend planning from individual controls to whole-dashboard priorities:
  overview, room/task groupings, details, alerts, and navigation.
- [ ] Preview the composed dashboard and allow refinement at dashboard, view,
  section, card, or component scope while preserving unrelated content.
- [ ] Provide target profiles for phone, tablet, wall panel, and desktop, including
  density, touch needs, viewing distance, and motion preferences.
- [ ] Publish to a new UI-managed dashboard or new view by default. Existing
  dashboard modifications require an explicit target and reviewable change list.
- [ ] Recheck permissions, entity scope, capabilities, renderer support, and
  dashboard revision immediately before publication.
- [ ] Add duplicate-submission protection and publication records. Rollback must
  be revision-aware and must not overwrite subsequent user edits.
- [ ] Keep YAML export for manually managed installations and define how project
  references/assets become portable, independently usable configurations.

Acceptance: a user describes a household dashboard, reviews a consistent set of
views and cards at different widths, changes one room's controls, and publishes a
new dashboard. Existing dashboards remain unchanged, and every generated card can
still run independently through the production renderer.

## Evaluation And Release Gates

Evaluate actual model-generated outputs as well as curated demo fixtures.

| Dimension | Required Evidence |
| --- | --- |
| Function | Required readings and supported controls match the functional plan. |
| Data | Values derive from authorized live/history sources; fixtures remain demo-only. |
| Safety | Entity scope, action policy, confirmations, and project ownership are enforced. |
| Usability | Keyboard, focus, touch, labels, unavailable states, and pending/error feedback work. |
| Visual quality | No unintended clipping/overlap at target widths; hierarchy and style match the brief. |
| Continuity | State updates preserve interaction and animation; failed jobs preserve prior work. |
| Publication | Supported targets render correctly; conflicts and failures preserve unrelated content. |
| Performance | Record DOM/SVG size, animation frame time, state-update cost, and subscription count. |

- [ ] Establish reproducible request fixtures for light/switch stacks, single- and
  dual-setpoint climate devices, weather, media, energy history, security, and
  mixed-room controls.
- [ ] Include long labels, localization, missing entities, unavailable devices,
  changing capabilities, provider failures, and rapid HA updates.
- [ ] Record baseline generation success, repair rate, task completion, latency,
  and visual findings before setting numeric release targets.
- [ ] Run browser interaction and screenshot checks using the production renderer;
  validate HA-specific subscriptions and publishing in disposable Home Assistant.
- [ ] Define release thresholds before declaring a milestone complete. Automated
  checks support, but do not replace, human visual review of representative output.
- [ ] Update the roadmap and supported-capability documentation with each shipped
  stage. Do not mark a stage complete solely because its schema exists.

## Immediate Implementation Sequence

1. Finish foundation regressions and define the project/candidate storage contract.
2. Implement project ownership, persistence, and recovery APIs.
3. Add console project recovery and candidate history.
4. Implement refinement with the current artifact, stable IDs, and unchanged-region
   validation.
5. Validate recovery, targeted edits, failed generation, and restore end to end.
6. Ship Stage 1, then begin the structured functional-planning and quality pipeline.

This sequence implements the dashboard goal incrementally while making the
existing card-generation workflow more dependable at every step.

## Progress Log

- 2026-11-08: Documented the reviewed product direction, architecture decisions,
  five delivery stages, foundation fixes, acceptance criteria, and immediate
  implementation sequence. All implementation tasks remain planned.
