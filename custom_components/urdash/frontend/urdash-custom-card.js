class UrDashCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
  }

  setConfig(config) {
    this._config = config || {};
    this._dashboard = this._parseDashboard(this._config);
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    const sections = this._dashboard?.sections || [];
    return Math.max(3, Math.min(12, 2 + sections.length * 2));
  }

  _parseDashboard(config) {
    if (config.dashboard && typeof config.dashboard === "object") {
      return config.dashboard;
    }
    if (typeof config.dashboard_json === "string") {
      try {
        return JSON.parse(config.dashboard_json);
      } catch (error) {
        throw new Error(`Invalid UrDash dashboard_json: ${error.message}`);
      }
    }
    throw new Error("UrDash card requires dashboard or dashboard_json.");
  }

  _render() {
    if (!this.shadowRoot || !this._dashboard) return;
    this.shadowRoot.innerHTML = `
      <style>${styles}</style>
      <div class="${this._shellClass()}">
        ${this._config.height_mode === "viewport" ? '<div class="viewport-spacer"></div>' : ""}
      </div>
    `;
    const shell = this.shadowRoot.querySelector(".custom-dashboard");
    if (this._config.height) {
      shell.style.setProperty("--urdash-card-height", `${Number(this._config.height) || 720}px`);
    }
    this._mountDashboard(shell, this._dashboard);
  }

  _shellClass() {
    const theme = this._safeTheme(this._dashboard?.theme);
    const heightMode = ["auto", "viewport", "fixed"].includes(this._config.height_mode)
      ? this._config.height_mode
      : "auto";
    return `custom-dashboard custom-dashboard-${theme} height-${heightMode}`;
  }

  _mountDashboard(shell, dashboard) {
    const hero = document.createElement("div");
    hero.className = "custom-dashboard-hero";
    const title = document.createElement("h3");
    title.textContent = dashboard.title || "UrDash";
    const subtitle = document.createElement("p");
    subtitle.textContent = dashboard.subtitle || "";
    hero.append(title, subtitle);
    shell.appendChild(hero);

    if (this._safeTheme(dashboard.theme) === "quiet") {
      shell.appendChild(this._createQuietHealthBar(dashboard));
    }

    for (const sectionConfig of dashboard.sections || []) {
      const section = document.createElement("section");
      section.className = `custom-dashboard-section custom-layout-${this._safeLayout(sectionConfig.layout)}`;
      const sectionHeader = document.createElement("div");
      sectionHeader.className = "custom-section-header";
      const sectionTitle = document.createElement("h4");
      sectionTitle.textContent = sectionConfig.title || "";
      const sectionSubtitle = document.createElement("p");
      sectionSubtitle.textContent = sectionConfig.subtitle || "";
      sectionHeader.append(sectionTitle, sectionSubtitle);
      section.appendChild(sectionHeader);

      const cards = document.createElement("div");
      cards.className = "custom-card-grid";
      for (const cardConfig of sectionConfig.cards || []) {
        cards.appendChild(this._createCustomCard(cardConfig));
      }
      section.appendChild(cards);
      shell.appendChild(section);
    }
  }

  _createQuietHealthBar(dashboard) {
    const bar = document.createElement("div");
    bar.className = "custom-quiet-health";
    const signals = [
      ["Secure", "lock", ["lock", "binary_sensor", "alarm_control_panel"]],
      ["Comfortable", "thermostat", ["climate", "sensor"]],
      ["Efficient", "flash", ["sensor", "switch"]],
      ["Quiet", "weather-night", ["media_player", "fan", "light"]],
    ];
    const allEntityIds = (dashboard.sections || [])
      .flatMap((section) => section.cards || [])
      .flatMap((card) => card.entity_ids || []);
    for (const [label, icon, domains] of signals) {
      const item = document.createElement("div");
      item.className = "custom-quiet-signal";
      item.append(this._createIcon(`mdi:${icon}`));
      const text = document.createElement("span");
      text.textContent = label;
      const stateText = document.createElement("strong");
      const matching = allEntityIds
        .map((entityId) => this._hass?.states?.[entityId])
        .filter((state) => state && domains.includes(state.entity_id.split(".", 1)[0]));
      stateText.textContent = matching.length ? `${matching.length} signals` : "ready";
      item.append(text, stateText);
      bar.appendChild(item);
    }
    return bar;
  }

  _createCustomCard(cardConfig) {
    const card = document.createElement("article");
    card.className = `custom-card custom-card-${this._safeCardType(cardConfig.type)}`;
    card.style.setProperty("--accent", this._safeAccent(cardConfig.accent));

    const header = document.createElement("div");
    header.className = "custom-card-header";
    header.appendChild(this._createIcon(cardConfig.icon));
    const headerText = document.createElement("div");
    const title = document.createElement("h5");
    title.textContent = cardConfig.title || "Card";
    const subtitle = document.createElement("p");
    subtitle.textContent = cardConfig.subtitle || "";
    headerText.append(title, subtitle);
    header.appendChild(headerText);
    card.appendChild(header);

    const entities = (cardConfig.entity_ids || [])
      .map((entityId) => this._hass?.states?.[entityId])
      .filter(Boolean);

    if (cardConfig.type === "orbit") card.appendChild(this._createOrbitBody(entities));
    else if (cardConfig.type === "scene") card.appendChild(this._createSceneBody(cardConfig, entities));
    else if (cardConfig.type === "climate" && entities[0]) card.appendChild(this._createClimateBody(entities[0]));
    else if (cardConfig.type === "metric" && entities[0]) card.appendChild(this._createMetricBody(entities[0]));
    else if (cardConfig.type === "control" && entities[0]?.entity_id?.startsWith("climate.")) card.appendChild(this._createClimateBody(entities[0]));
    else if (cardConfig.type === "control") card.appendChild(this._createControlBody(entities));
    else if (cardConfig.type === "timeline") card.appendChild(this._createTimelineBody(entities));
    else if (cardConfig.type === "hero" && entities.length) card.appendChild(this._createHeroBody(entities));
    else card.appendChild(this._createEntityList(entities));

    return card;
  }

  _createOrbitBody(entities) {
    const orbit = document.createElement("div");
    orbit.className = "custom-orbit";
    const core = document.createElement("div");
    core.className = "custom-orbit-core";
    const active = entities.filter((state) => !["off", "closed", "idle", "unavailable"].includes(state.state)).length;
    const count = document.createElement("strong");
    count.textContent = String(active);
    const label = document.createElement("span");
    label.textContent = "active signals";
    core.append(count, label);
    orbit.appendChild(core);

    const positions = [["-38%", "-34%"], ["8%", "-42%"], ["35%", "-14%"], ["28%", "34%"], ["-18%", "42%"], ["-44%", "8%"]];
    for (const [index, state] of entities.slice(0, 6).entries()) {
      const satellite = document.createElement("span");
      satellite.className = "custom-orbit-satellite";
      satellite.style.setProperty("--x", positions[index][0]);
      satellite.style.setProperty("--y", positions[index][1]);
      satellite.textContent = `${this._stateName(state)}: ${state.state}`;
      orbit.appendChild(satellite);
    }
    return orbit;
  }

  _createSceneBody(cardConfig, entities) {
    const scene = document.createElement("div");
    scene.className = "custom-scene";
    const phrase = document.createElement("p");
    phrase.textContent = cardConfig.subtitle || "One tap home mode";
    scene.appendChild(phrase);
    const actions = document.createElement("div");
    actions.className = "custom-action-row";
    for (const state of entities.slice(0, 4)) actions.appendChild(this._createEntityActionButton(state));
    scene.appendChild(actions);
    return scene;
  }

  _createControlBody(entities) {
    const controls = document.createElement("div");
    controls.className = "custom-control-grid";
    for (const state of entities.slice(0, 6)) controls.appendChild(this._createEntityActionButton(state));
    if (!entities.length) controls.appendChild(this._empty("No matching controls are available."));
    return controls;
  }

  _createClimateBody(state) {
    const climate = document.createElement("div");
    climate.className = "custom-climate";

    const current = state.attributes?.current_temperature ?? state.attributes?.temperature ?? state.state;
    const target = state.attributes?.temperature ?? current;
    const unit = this._hass?.config?.unit_system?.temperature || state.attributes?.unit_of_measurement || "°";

    const readout = document.createElement("div");
    readout.className = "custom-climate-readout";
    const currentValue = document.createElement("strong");
    currentValue.textContent = `${current}${unit}`;
    const currentLabel = document.createElement("span");
    currentLabel.textContent = `Current · ${state.state}`;
    readout.append(currentValue, currentLabel);

    const targetBox = document.createElement("div");
    targetBox.className = "custom-climate-target";
    const targetLabel = document.createElement("span");
    targetLabel.textContent = "Target";
    const targetValue = document.createElement("strong");
    targetValue.textContent = `${target}${unit}`;
    const steppers = document.createElement("div");
    steppers.className = "custom-climate-steppers";
    steppers.append(
      this._createClimateStepButton(state, target, -1),
      this._createClimateStepButton(state, target, 1),
    );
    targetBox.append(targetLabel, targetValue, steppers);

    const modes = document.createElement("div");
    modes.className = "custom-climate-modes";
    for (const mode of (state.attributes?.hvac_modes || []).slice(0, 6)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = mode === state.state ? "active" : "";
      button.textContent = mode;
      button.addEventListener("click", () => this._hass.callService("climate", "set_hvac_mode", {
        entity_id: state.entity_id,
        hvac_mode: mode,
      }));
      modes.appendChild(button);
    }

    climate.append(readout, targetBox, modes);
    return climate;
  }

  _createClimateStepButton(state, target, delta) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = delta > 0 ? "+" : "-";
    button.addEventListener("click", () => {
      const next = Number(target) + delta;
      if (Number.isFinite(next)) {
        this._hass.callService("climate", "set_temperature", {
          entity_id: state.entity_id,
          temperature: next,
        });
      }
    });
    return button;
  }

  _createTimelineBody(entities) {
    const timeline = document.createElement("div");
    timeline.className = "custom-timeline";
    for (const state of entities.slice(0, 6)) {
      const item = document.createElement("div");
      item.className = "custom-timeline-item";
      const dot = document.createElement("span");
      const text = document.createElement("p");
      text.textContent = `${this._stateName(state)} is ${state.state}`;
      item.append(dot, text);
      timeline.appendChild(item);
    }
    return timeline;
  }

  _createHeroBody(entities) {
    const heroStates = document.createElement("div");
    heroStates.className = "custom-hero-states";
    for (const state of entities.slice(0, 4)) {
      const pill = document.createElement("span");
      pill.className = "custom-state-pill";
      pill.textContent = `${this._stateName(state)}: ${state.state}`;
      heroStates.appendChild(pill);
    }
    return heroStates;
  }

  _createMetricBody(state) {
    const metric = document.createElement("div");
    metric.className = "custom-metric";
    const value = document.createElement("strong");
    value.textContent = `${state.state}${state.attributes?.unit_of_measurement || ""}`;
    const label = document.createElement("span");
    label.textContent = this._stateName(state);
    metric.append(value, label);
    return metric;
  }

  _createEntityList(entities) {
    const list = document.createElement("div");
    list.className = "custom-entity-list";
    for (const state of entities.slice(0, 8)) {
      const row = document.createElement("div");
      row.className = "custom-entity-line";
      const name = document.createElement("span");
      name.textContent = this._stateName(state);
      const value = document.createElement("strong");
      value.textContent = `${state.state}${state.attributes?.unit_of_measurement || ""}`;
      row.append(name, value);
      list.appendChild(row);
    }
    if (!entities.length) list.appendChild(this._empty("No matching entities are available."));
    return list;
  }

  _createEntityActionButton(state) {
    const button = document.createElement("button");
    button.className = "custom-action";
    button.type = "button";
    button.disabled = !this._canToggleState(state);
    const name = document.createElement("span");
    name.textContent = this._stateName(state);
    const value = document.createElement("strong");
    value.textContent = state.state;
    button.append(name, value);
    button.addEventListener("click", () => this._callToggleService(state));
    return button;
  }

  _createIcon(icon) {
    const iconElement = document.createElement("ha-icon");
    iconElement.setAttribute("icon", icon && icon.startsWith("mdi:") ? icon : "mdi:view-dashboard");
    return iconElement;
  }

  _empty(text) {
    const empty = document.createElement("p");
    empty.className = "custom-empty";
    empty.textContent = text;
    return empty;
  }

  _stateName(state) {
    return state.attributes?.friendly_name || state.entity_id;
  }

  _canToggleState(state) {
    return ["automation", "fan", "humidifier", "input_boolean", "light", "lock", "media_player", "script", "switch"].includes(
      state.entity_id.split(".", 1)[0],
    );
  }

  _callToggleService(state) {
    if (!this._canToggleState(state)) return;
    const domain = state.entity_id.split(".", 1)[0];
    const service = domain === "lock" && state.state === "locked" ? "unlock" : domain === "lock" ? "lock" : "toggle";
    this._hass.callService(domain, service, { entity_id: state.entity_id });
  }

  _safeTheme(theme) {
    return ["aurora", "calm", "graphite", "sunrise", "quiet"].includes(theme) ? theme : "aurora";
  }

  _safeLayout(layout) {
    return ["feature", "grid", "dense"].includes(layout) ? layout : "grid";
  }

  _safeCardType(type) {
    return ["hero", "orbit", "scene", "status", "metric", "climate", "control", "timeline", "list"].includes(type) ? type : "status";
  }

  _safeAccent(accent) {
    const value = String(accent || "").trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
    if (/^(rgb|hsl)a?\([0-9%.,\s-]+\)$/.test(value)) return value;
    return "#1f8a70";
  }
}

const styles = `
  :host { display: block; }
  * { box-sizing: border-box; }
  button { font: inherit; }
  h3, h4, h5, p { margin: 0; }
  .custom-dashboard {
    --custom-bg: radial-gradient(circle at 18% 14%, rgba(31,138,112,0.26), transparent 26%),
      radial-gradient(circle at 86% 10%, rgba(215,138,63,0.2), transparent 24%),
      linear-gradient(145deg, #ecf8f4, #f8f3ea 48%, #e8f0f5);
    --custom-fg: #112a2d;
    --custom-muted: #587074;
    --custom-panel: rgba(255,255,255,0.64);
    display: grid;
    gap: 22px;
    min-height: var(--urdash-min-height, auto);
    border-radius: 8px;
    padding: 22px;
    background: var(--custom-bg);
    color: var(--custom-fg);
    position: relative;
    overflow: hidden;
    font-family: var(--paper-font-body1_-_font-family, Inter, ui-sans-serif, system-ui, sans-serif);
  }
  .height-viewport { min-height: min(760px, 92vh); }
  .height-fixed { height: var(--urdash-card-height, 720px); overflow: auto; }
  .custom-dashboard::before {
    content: "";
    position: absolute;
    inset: 14px;
    border: 1px solid rgba(255,255,255,0.55);
    border-radius: 8px;
    pointer-events: none;
  }
  .custom-dashboard-aurora { --custom-bg: linear-gradient(135deg, #edf8f5, #f7efe6); --custom-fg: #102b2f; --custom-muted: #5a6f73; }
  .custom-dashboard-calm { --custom-bg: linear-gradient(135deg, #f4f7f8, #e8f0ed); --custom-fg: #1d3034; --custom-muted: #65777a; }
  .custom-dashboard-graphite { --custom-bg: linear-gradient(135deg, #172326, #283338); --custom-fg: #eef7f4; --custom-muted: #b6c4c5; --custom-panel: rgba(255,255,255,0.1); }
  .custom-dashboard-sunrise { --custom-bg: linear-gradient(135deg, #fff6e8, #eaf7f2); --custom-fg: #2a2c26; --custom-muted: #766f61; }
  .custom-dashboard-quiet { --custom-bg: linear-gradient(135deg, #fafaf7, #f2f5f3); --custom-fg: #202728; --custom-muted: #6d7675; --custom-panel: rgba(255,255,255,0.42); gap: 18px; padding: 24px; }
  .custom-dashboard-quiet::before { inset: 18px; border-color: rgba(36,45,45,0.08); }
  .custom-dashboard-hero, .custom-dashboard-section, .custom-quiet-health { position: relative; z-index: 1; }
  .custom-dashboard-hero { display: grid; gap: 8px; }
  .custom-dashboard-hero h3 { color: var(--custom-fg); max-width: 720px; font-size: 30px; line-height: 1.04; }
  .custom-dashboard-hero p, .custom-section-header p, .custom-card-header p, .custom-metric span, .custom-empty { color: var(--custom-muted); }
  .custom-dashboard-quiet .custom-dashboard-hero { border-bottom: 1px solid rgba(32,39,40,0.1); padding-bottom: 14px; }
  .custom-dashboard-quiet .custom-dashboard-hero h3 { max-width: none; font-size: 26px; font-weight: 850; }
  .custom-quiet-health { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-bottom: 1px solid rgba(32,39,40,0.1); padding-bottom: 14px; }
  .custom-quiet-signal { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 5px 8px; align-items: center; padding-right: 12px; }
  .custom-quiet-signal ha-icon { width: 18px; height: 18px; color: #1f8a70; }
  .custom-quiet-signal span { color: var(--custom-fg); font-size: 12px; font-weight: 850; }
  .custom-quiet-signal strong { grid-column: 2; color: var(--custom-muted); font-size: 11px; font-weight: 650; }
  .custom-dashboard-section { display: grid; gap: 12px; }
  .custom-section-header h4 { color: var(--custom-fg); font-size: 18px; }
  .custom-card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
  .custom-layout-feature .custom-card-grid { grid-template-columns: minmax(260px, 1.4fr) repeat(auto-fit, minmax(210px, 1fr)); }
  .custom-layout-dense .custom-card-grid { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
  .custom-card {
    backdrop-filter: blur(18px);
    display: grid;
    gap: 14px;
    min-height: 150px;
    border: 1px solid rgba(255,255,255,0.42);
    border-radius: 8px;
    padding: 16px;
    background: var(--custom-panel);
    box-shadow: 0 20px 48px rgba(19,35,38,0.14);
    overflow: hidden;
    position: relative;
  }
  .custom-card-hero, .custom-card-orbit, .custom-card-scene { min-height: 210px; }
  .custom-layout-feature .custom-card-climate { min-height: 220px; }
  .custom-card-header { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 10px; align-items: start; }
  .custom-card-header ha-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; background: var(--accent); color: #fff; }
  .custom-card-header h5 { color: var(--custom-fg); font-size: 15px; }
  .custom-card-header p { margin-top: 3px; font-size: 12px; }
  .custom-dashboard-quiet .custom-card-grid { gap: 0; border-top: 1px solid rgba(32,39,40,0.1); }
  .custom-dashboard-quiet .custom-card { min-height: 0; border: 0; border-bottom: 1px solid rgba(32,39,40,0.1); border-radius: 0; padding: 14px 0; background: transparent; box-shadow: none; backdrop-filter: none; }
  .custom-dashboard-quiet .custom-card-climate { min-height: 210px; place-content: center; }
  .custom-dashboard-quiet .custom-card-header { grid-template-columns: 24px minmax(0, 1fr); }
  .custom-dashboard-quiet .custom-card-header ha-icon { width: 24px; height: 24px; background: transparent; color: var(--accent); }
  .custom-metric { display: grid; gap: 4px; align-self: end; }
  .custom-metric strong { color: var(--custom-fg); font-size: 40px; line-height: 1; }
  .custom-dashboard-quiet .custom-metric { place-items: center; }
  .custom-dashboard-quiet .custom-metric strong { font-size: 52px; font-weight: 780; }
  .custom-climate { display: grid; grid-template-columns: minmax(120px, 1fr) minmax(120px, 0.9fr); gap: 14px; align-items: end; }
  .custom-climate-readout, .custom-climate-target { display: grid; gap: 5px; }
  .custom-climate-readout strong { color: var(--custom-fg); font-size: 42px; line-height: 1; }
  .custom-climate-readout span, .custom-climate-target span { color: var(--custom-muted); font-size: 12px; }
  .custom-climate-target strong { color: var(--custom-fg); font-size: 24px; }
  .custom-climate-steppers, .custom-climate-modes { display: flex; flex-wrap: wrap; gap: 7px; }
  .custom-climate-steppers button, .custom-climate-modes button { min-height: 34px; border: 1px solid rgba(255,255,255,0.48); border-radius: 8px; padding: 0 12px; background: rgba(255,255,255,0.58); color: var(--custom-fg); cursor: pointer; font-weight: 850; }
  .custom-climate-modes { grid-column: 1 / -1; }
  .custom-climate-modes button.active { background: var(--accent); color: #fff; }
  .custom-dashboard-quiet .custom-climate { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .custom-dashboard-quiet .custom-climate-readout strong { font-size: 54px; font-weight: 780; }
  .custom-dashboard-quiet .custom-climate-target { grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; border-top: 1px solid rgba(32,39,40,0.08); padding-top: 10px; }
  .custom-dashboard-quiet .custom-climate-target strong { font-size: 18px; }
  .custom-dashboard-quiet .custom-climate-steppers button, .custom-dashboard-quiet .custom-climate-modes button { border-color: rgba(32,39,40,0.12); background: transparent; }
  .custom-hero-states, .custom-action-row { display: flex; flex-wrap: wrap; gap: 8px; align-self: end; }
  .custom-state-pill { border-radius: 999px; padding: 7px 10px; background: rgba(255,255,255,0.58); color: var(--custom-fg); font-size: 12px; font-weight: 800; }
  .custom-orbit { min-height: 178px; position: relative; }
  .custom-orbit-core { position: absolute; inset: 50% auto auto 50%; display: grid; place-items: center; width: 104px; height: 104px; border: 1px solid color-mix(in srgb, var(--accent) 35%, white); border-radius: 999px; background: color-mix(in srgb, var(--accent) 16%, rgba(255,255,255,0.74)); transform: translate(-50%, -50%); }
  .custom-orbit-core strong { color: var(--custom-fg); font-size: 28px; line-height: 1; }
  .custom-orbit-core span { color: var(--custom-muted); font-size: 10px; font-weight: 800; text-transform: uppercase; }
  .custom-orbit-satellite { position: absolute; left: calc(50% + var(--x)); top: calc(50% + var(--y)); max-width: 118px; border-radius: 999px; padding: 6px 9px; background: rgba(255,255,255,0.72); color: var(--custom-fg); font-size: 10px; font-weight: 800; transform: translate(-50%, -50%); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .custom-scene { display: grid; gap: 14px; align-self: end; }
  .custom-scene > p { max-width: 420px; color: var(--custom-fg); font-size: 22px; font-weight: 900; line-height: 1.1; }
  .custom-control-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 9px; }
  .custom-dashboard-quiet .custom-action-row, .custom-dashboard-quiet .custom-control-grid { display: grid; grid-template-columns: 1fr; gap: 0; }
  .custom-action { min-height: 58px; display: grid; gap: 3px; border: 1px solid rgba(255,255,255,0.45); border-radius: 8px; padding: 9px 11px; background: rgba(255,255,255,0.62); color: var(--custom-fg); cursor: pointer; text-align: left; }
  .custom-action:disabled { cursor: default; opacity: 0.78; }
  .custom-action span { font-size: 11px; overflow-wrap: anywhere; }
  .custom-action strong { font-size: 13px; text-transform: uppercase; }
  .custom-dashboard-quiet .custom-action { min-height: 46px; grid-template-columns: minmax(0, 1fr) auto; align-items: center; border: 0; border-top: 1px solid rgba(32,39,40,0.08); border-radius: 0; padding: 9px 0; background: transparent; }
  .custom-timeline, .custom-entity-list { display: grid; gap: 9px; }
  .custom-timeline-item { display: grid; grid-template-columns: 12px minmax(0, 1fr); gap: 9px; align-items: start; }
  .custom-timeline-item span { width: 10px; height: 10px; margin-top: 4px; border-radius: 999px; background: var(--accent); box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 18%, transparent); }
  .custom-timeline-item p, .custom-entity-line { color: var(--custom-fg); font-size: 12px; }
  .custom-entity-line { display: flex; justify-content: space-between; gap: 10px; }
  .custom-entity-line span { min-width: 0; overflow-wrap: anywhere; }
  .custom-entity-line strong { white-space: nowrap; }
  @media (max-width: 640px) {
    .custom-dashboard { padding: 16px; }
    .custom-quiet-health { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  }
`;

customElements.define("urdash-card", UrDashCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "urdash-card",
  name: "UrDash Card",
  description: "Renders AI-generated UrDash custom card specs.",
});
