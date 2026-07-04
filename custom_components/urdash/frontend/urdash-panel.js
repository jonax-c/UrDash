class UrDashPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._entities = [];
    this._resources = [];
    this._referenceViews = [];
    this._settings = {
      ai_enabled: false,
      ai_provider: "openai",
      model: "",
      default_style: "modern",
      allow_custom_cards: true,
    };
    this._result = null;
    this._style = "modern";
    this._allowCustomCards = true;
    this._mode = "new_view";
    this._referenceViewId = "";
    this._selectedEntityIds = new Set();
    this._entityFilter = "";
    this._appendResult = null;
    this._previewResult = null;
    this._loaded = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._loaded) {
      this._loaded = true;
      this._load();
    } else {
      this._refreshPreviewHass();
    }
  }

  async _load() {
    this._render();
    try {
      const [entityPayload, resourcePayload, settingsPayload, referencePayload] = await Promise.all([
        this._hass.connection.sendMessagePromise({ type: "urdash/entities" }),
        this._hass.connection.sendMessagePromise({ type: "urdash/resources" }),
        this._hass.connection.sendMessagePromise({ type: "urdash/settings" }),
        this._hass.connection.sendMessagePromise({ type: "urdash/reference_views" }),
      ]);
      this._entities = entityPayload.entities || [];
      this._selectedEntityIds = new Set(this._entities.map((entity) => entity.entity_id).filter(Boolean));
      this._resources = resourcePayload.resources || [];
      this._referenceViews = referencePayload.views || [];
      this._referenceViewId = this._referenceViews[0]?.id || "";
      this._settings = { ...this._settings, ...settingsPayload };
      this._style = this._settings.default_style || this._style;
      this._allowCustomCards = Boolean(this._settings.allow_custom_cards);
      this._render();
      if (this._isValidationMode()) {
        this._result = VALIDATION_RESULT;
        this._appendResult = null;
        this._previewResult = null;
        this._render();
        if (this._isValidationAutoPreview()) await this._writePreview();
      }
    } catch (error) {
      this._renderError(error);
    }
  }

  async _generate() {
    const requestInput = this.shadowRoot.querySelector("#request");
    const request = requestInput.value.trim();
    if (!request) return;
    if (!this._selectedEntityCount()) return;

    const button = this.shadowRoot.querySelector("#generate");
    button.disabled = true;
    button.innerHTML = '<span class="spin">*</span> Generating';

    try {
      this._result = await this._hass.connection.sendMessagePromise({
        type: "urdash/generate",
        request,
        style: this._style,
        allow_custom_cards: this._allowCustomCards,
        mode: this._mode,
        reference_view_id: this._mode === "new_view" ? this._referenceViewId : undefined,
        selected_entity_ids: this._selectedEntityIdsList(),
      });
      this._appendResult = null;
      this._previewResult = null;
      this._render();
    } catch (error) {
      this._renderError(error);
    } finally {
      const currentButton = this.shadowRoot.querySelector("#generate");
      if (currentButton) {
        currentButton.disabled = false;
        currentButton.innerHTML = "<span>*</span> Generate dashboard";
      }
    }
  }

  async _copyYaml() {
    const output = this._resultText();
    if (!output) return;
    await navigator.clipboard.writeText(output);
    const copyButton = this.shadowRoot.querySelector("#copyYaml");
    copyButton.textContent = "OK";
    window.setTimeout(() => {
      const currentButton = this.shadowRoot.querySelector("#copyYaml");
      if (currentButton) currentButton.textContent = "Copy";
    }, 1400);
  }

  async _appendView() {
    if (!this._result?.view) return;

    const button = this.shadowRoot.querySelector("#appendView");
    button.disabled = true;
    button.textContent = "Adding";

    try {
      this._appendResult = await this._hass.connection.sendMessagePromise({
        type: "urdash/append_view",
        view: this._result.view,
      });
      this._render();
    } catch (error) {
      this._appendResult = { ok: false, error: error?.message || String(error) };
      this._render();
    }
  }

  async _writePreview() {
    if (this._result?.custom_dashboard) {
      const button = this.shadowRoot.querySelector("#writePreview");
      button.disabled = true;
      button.textContent = "Rendering";
      this._previewResult = { ok: null, message: "Preparing custom dashboard preview." };
      this._render();
      try {
        await this._nextFrame();
        this._mountCustomDashboard(this._result.custom_dashboard);
        this._previewResult = {
          ok: true,
          message: "Rendered with UrDash custom dashboard renderer.",
        };
        this._updatePreviewStatus();
      } catch (error) {
        this._previewResult = { ok: false, error: error?.message || String(error) };
        this._render();
      } finally {
        const currentButton = this.shadowRoot.querySelector("#writePreview");
        if (currentButton) {
          currentButton.disabled = false;
          currentButton.textContent = "Preview";
        }
      }
      return;
    }

    const view = this._previewView();
    if (!view) return;

    const button = this.shadowRoot.querySelector("#writePreview");
    button.disabled = true;
    button.textContent = "Rendering";
    this._previewResult = { ok: null, message: "Preparing Lovelace preview." };
    this._render();

    try {
      await this._nextFrame();
      await this._mountLovelacePreview(view);
      this._previewResult = {
        ok: true,
        message: "Rendered with Home Assistant Lovelace card helpers.",
      };
      this._updatePreviewStatus();
    } catch (error) {
      this._previewResult = { ok: false, error: error?.message || String(error) };
      this._render();
    } finally {
      const currentButton = this.shadowRoot.querySelector("#writePreview");
      if (currentButton) {
        currentButton.disabled = false;
        currentButton.textContent = "Preview";
      }
    }
  }

  _setStyle(style) {
    this._style = style;
    this._render();
  }

  _toggleCustomCards(checked) {
    this._allowCustomCards = checked;
    this._render();
  }

  _setMode(mode) {
    this._mode = mode;
    this._render();
  }

  _setReferenceView(referenceViewId) {
    this._referenceViewId = referenceViewId;
    this._render();
  }

  _setEntityFilter(value) {
    this._entityFilter = value;
    this._refreshEntitySelectionMarkup();
  }

  _toggleEntity(entityId, checked) {
    if (checked) this._selectedEntityIds.add(entityId);
    else this._selectedEntityIds.delete(entityId);
    this._render();
  }

  _toggleEntityGroup(groupId, checked) {
    const group = this._deviceGroups().find((item) => item.id === groupId);
    if (!group) return;
    for (const entity of group.entities) {
      if (checked) this._selectedEntityIds.add(entity.entity_id);
      else this._selectedEntityIds.delete(entity.entity_id);
    }
    this._render();
  }

  _selectAllEntities() {
    this._selectedEntityIds = new Set(this._entities.map((entity) => entity.entity_id).filter(Boolean));
    this._render();
  }

  _selectNoEntities() {
    this._selectedEntityIds = new Set();
    this._render();
  }

  _selectedEntityIdsList() {
    return this._entities
      .map((entity) => entity.entity_id)
      .filter((entityId) => this._selectedEntityIds.has(entityId));
  }

  _selectedEntityCount() {
    return this._selectedEntityIdsList().length;
  }

  _refreshEntitySelectionMarkup() {
    const groups = this.shadowRoot.querySelector(".entity-groups");
    if (groups) {
      groups.innerHTML = this._entitySelectionMarkup();
    }
  }

  _deviceGroups() {
    const filter = this._entityFilter.trim().toLowerCase();
    const groups = new Map();
    for (const entity of this._entities) {
      const groupId = entity.device_id || `domain:${entity.domain || entity.entity_id?.split(".")[0] || "other"}`;
      const groupTitle = entity.device_name || this._domainTitle(entity.domain || entity.entity_id?.split(".")[0]);
      const area = entity.area_name || "No area";
      if (!groups.has(groupId)) {
        groups.set(groupId, {
          id: groupId,
          title: groupTitle || "Other",
          area,
          entities: [],
        });
      }
      groups.get(groupId).entities.push(entity);
    }

    return [...groups.values()]
      .map((group) => ({
        ...group,
        entities: group.entities
          .filter((entity) => this._entityMatchesFilter(entity, group, filter))
          .sort((a, b) => String(this._entityLabel(a)).localeCompare(String(this._entityLabel(b)))),
      }))
      .filter((group) => group.entities.length)
      .sort((a, b) => `${a.area} ${a.title}`.localeCompare(`${b.area} ${b.title}`));
  }

  _entityMatchesFilter(entity, group, filter) {
    if (!filter) return true;
    return [
      entity.entity_id,
      this._entityLabel(entity),
      group.title,
      group.area,
      entity.domain,
    ].some((value) => String(value || "").toLowerCase().includes(filter));
  }

  _domainTitle(domain) {
    if (!domain) return "Other";
    return domain.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
  }

  _entityLabel(entity) {
    return entity.name || entity.attributes?.friendly_name || entity.entity_id;
  }

  _domainStats() {
    const counts = new Map();
    for (const entity of this._entities) {
      const domain = entity.entity_id?.split(".")[0];
      if (domain) counts.set(domain, (counts.get(domain) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }

  _previewView() {
    if (this._result?.view) return this._result.view;
    const views = this._result?.dashboard?.views;
    return Array.isArray(views) ? views[0] : null;
  }

  _canPreview() {
    return Boolean(this._result?.custom_dashboard || this._previewView());
  }

  _resultText() {
    if (this._result?.custom_dashboard) {
      return JSON.stringify(this._result.custom_dashboard, null, 2);
    }
    return this._result?.yaml || "";
  }

  _resultLabel() {
    return this._result?.custom_dashboard ? "Custom dashboard JSON" : "Lovelace YAML";
  }

  _mountCustomDashboard(dashboard) {
    const host = this.shadowRoot.querySelector("#lovelacePreviewHost");
    if (!host) throw new Error("Preview host was not found.");
    host.innerHTML = "";

    const shell = document.createElement("div");
    shell.className = `custom-dashboard custom-dashboard-${this._safeTheme(dashboard.theme)}`;

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

    host.appendChild(shell);
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
      const haIcon = document.createElement("ha-icon");
      haIcon.setAttribute("icon", `mdi:${icon}`);
      const text = document.createElement("span");
      text.textContent = label;
      const stateText = document.createElement("strong");
      const matching = allEntityIds
        .map((entityId) => this._hass?.states?.[entityId])
        .filter((state) => state && domains.includes(state.entity_id.split(".", 1)[0]));
      stateText.textContent = matching.length ? `${matching.length} signals` : "ready";
      item.append(haIcon, text, stateText);
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
    header.appendChild(this._createCustomIcon(cardConfig.icon));
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

    if (cardConfig.type === "orbit") {
      card.appendChild(this._createOrbitBody(entities));
      return card;
    }

    if (cardConfig.type === "scene") {
      card.appendChild(this._createSceneBody(cardConfig, entities));
      return card;
    }

    if (cardConfig.type === "metric" && entities[0]) {
      card.appendChild(this._createMetricBody(entities[0]));
      return card;
    }

    if (cardConfig.type === "control") {
      card.appendChild(this._createControlBody(entities));
      return card;
    }

    if (cardConfig.type === "timeline") {
      card.appendChild(this._createTimelineBody(entities));
      return card;
    }

    if (cardConfig.type === "hero" && entities.length) {
      const heroStates = document.createElement("div");
      heroStates.className = "custom-hero-states";
      for (const state of entities.slice(0, 4)) {
        heroStates.appendChild(this._createStatePill(state));
      }
      card.appendChild(heroStates);
      return card;
    }

    const list = document.createElement("div");
    list.className = "custom-entity-list";
    for (const state of entities.slice(0, 8)) {
      list.appendChild(this._createEntityLine(state));
    }
    if (!entities.length) {
      const empty = document.createElement("p");
      empty.className = "custom-empty";
      empty.textContent = "No matching entities are available.";
      list.appendChild(empty);
    }
    card.appendChild(list);
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

    const positions = [
      ["-38%", "-34%"],
      ["8%", "-42%"],
      ["35%", "-14%"],
      ["28%", "34%"],
      ["-18%", "42%"],
      ["-44%", "8%"],
    ];
    for (const [index, state] of entities.slice(0, 6).entries()) {
      const satellite = document.createElement("span");
      satellite.className = "custom-orbit-satellite";
      satellite.style.setProperty("--x", positions[index][0]);
      satellite.style.setProperty("--y", positions[index][1]);
      satellite.textContent = `${state.attributes?.friendly_name || state.entity_id}: ${state.state}`;
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
    for (const state of entities.slice(0, 4)) {
      actions.appendChild(this._createEntityActionButton(state));
    }
    scene.appendChild(actions);
    return scene;
  }

  _createControlBody(entities) {
    const controls = document.createElement("div");
    controls.className = "custom-control-grid";
    for (const state of entities.slice(0, 6)) {
      controls.appendChild(this._createEntityActionButton(state));
    }
    if (!entities.length) {
      const empty = document.createElement("p");
      empty.className = "custom-empty";
      empty.textContent = "No matching controls are available.";
      controls.appendChild(empty);
    }
    return controls;
  }

  _createTimelineBody(entities) {
    const timeline = document.createElement("div");
    timeline.className = "custom-timeline";
    for (const state of entities.slice(0, 6)) {
      const item = document.createElement("div");
      item.className = "custom-timeline-item";
      const dot = document.createElement("span");
      const text = document.createElement("p");
      text.textContent = `${state.attributes?.friendly_name || state.entity_id} is ${state.state}`;
      item.append(dot, text);
      timeline.appendChild(item);
    }
    return timeline;
  }

  _createEntityActionButton(state) {
    const button = document.createElement("button");
    button.className = "custom-action";
    button.type = "button";
    button.disabled = !this._canToggleState(state);
    const name = document.createElement("span");
    name.textContent = state.attributes?.friendly_name || state.entity_id;
    const value = document.createElement("strong");
    value.textContent = state.state;
    button.append(name, value);
    button.addEventListener("click", () => this._callToggleService(state));
    return button;
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

  _createMetricBody(state) {
    const metric = document.createElement("div");
    metric.className = "custom-metric";
    const value = document.createElement("strong");
    value.textContent = `${state.state}${state.attributes?.unit_of_measurement || ""}`;
    const label = document.createElement("span");
    label.textContent = state.attributes?.friendly_name || state.entity_id;
    metric.append(value, label);
    return metric;
  }

  _createStatePill(state) {
    const pill = document.createElement("span");
    pill.className = "custom-state-pill";
    pill.textContent = `${state.attributes?.friendly_name || state.entity_id}: ${state.state}`;
    return pill;
  }

  _createEntityLine(state) {
    const row = document.createElement("div");
    row.className = "custom-entity-line";
    const name = document.createElement("span");
    name.textContent = state.attributes?.friendly_name || state.entity_id;
    const value = document.createElement("strong");
    value.textContent = `${state.state}${state.attributes?.unit_of_measurement || ""}`;
    row.append(name, value);
    return row;
  }

  _createCustomIcon(icon) {
    const iconElement = document.createElement("ha-icon");
    iconElement.setAttribute("icon", icon && icon.startsWith("mdi:") ? icon : "mdi:view-dashboard");
    return iconElement;
  }

  _safeTheme(theme) {
    return ["aurora", "calm", "graphite", "sunrise", "quiet"].includes(theme) ? theme : "aurora";
  }

  _safeLayout(layout) {
    return ["feature", "grid", "dense"].includes(layout) ? layout : "grid";
  }

  _safeCardType(type) {
    return ["hero", "orbit", "scene", "status", "metric", "control", "timeline", "list"].includes(type) ? type : "status";
  }

  _safeAccent(accent) {
    const value = String(accent || "").trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
    if (/^(rgb|hsl)a?\([0-9%.,\s-]+\)$/.test(value)) return value;
    return "#1f8a70";
  }

  async _mountLovelacePreview(view) {
    const host = this.shadowRoot.querySelector("#lovelacePreviewHost");
    if (!host) throw new Error("Preview host was not found.");
    host.innerHTML = "";

    const title = document.createElement("div");
    title.className = "lovelace-preview-title";
    title.textContent = view.title || "UrDash Preview";
    host.appendChild(title);

    if (Array.isArray(view.sections) && view.sections.length) {
      const sections = document.createElement("div");
      sections.className = "lovelace-sections-preview";
      for (const sectionConfig of view.sections) {
        sections.appendChild(await this._createPreviewSection(sectionConfig));
      }
      host.appendChild(sections);
      return;
    }

    const cards = Array.isArray(view.cards) ? view.cards : [];
    if (!cards.length) {
      const empty = document.createElement("div");
      empty.className = "lovelace-render-error";
      empty.textContent = "Generated view has no cards to preview.";
      host.appendChild(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = view.type === "panel" ? "lovelace-panel-preview" : "lovelace-card-grid";
    for (const cardConfig of cards) {
      grid.appendChild(await this._createPreviewCard(cardConfig));
    }
    host.appendChild(grid);
  }

  async _createPreviewSection(sectionConfig) {
    const section = document.createElement("section");
    section.className = "lovelace-section";
    if (sectionConfig?.title) {
      const title = document.createElement("h4");
      title.textContent = sectionConfig.title;
      section.appendChild(title);
    }

    const cards = Array.isArray(sectionConfig?.cards) ? sectionConfig.cards : [];
    for (const cardConfig of cards) {
      section.appendChild(await this._createPreviewCard(cardConfig));
    }
    return section;
  }

  async _createPreviewCard(cardConfig) {
    const wrapper = document.createElement("div");
    wrapper.className = "lovelace-card-shell";
    try {
      const helpers = await this._loadCardHelpers();
      let element = null;
      if (helpers?.createCardElement) {
        element = helpers.createCardElement(cardConfig);
      } else {
        element = document.createElement("hui-card");
        if (element.setConfig) element.setConfig(cardConfig);
        else element.config = cardConfig;
      }
      element.hass = this._hass;
      wrapper.appendChild(element);
    } catch (error) {
      wrapper.appendChild(this._createRenderError(cardConfig, error));
    }
    return wrapper;
  }

  async _loadCardHelpers() {
    if (window.loadCardHelpers) return window.loadCardHelpers();
    throw new Error("Home Assistant Lovelace card helpers are not available in this frontend session.");
  }

  _createRenderError(cardConfig, error) {
    const errorBox = document.createElement("div");
    errorBox.className = "lovelace-render-error";
    errorBox.textContent = `${cardConfig?.type || "card"}: ${error?.message || String(error)}`;
    return errorBox;
  }

  _updatePreviewStatus() {
    const status = this.shadowRoot.querySelector("#previewStatus");
    if (!status || !this._previewResult) return;
    status.className = this._previewResult.ok ? "status-box success" : "status-box pending";
    status.textContent = this._previewResult.message || "Preview rendered.";
  }

  _refreshPreviewHass() {
    const host = this.shadowRoot.querySelector("#lovelacePreviewHost");
    if (!host) return;
    if (this._result?.custom_dashboard && this._previewResult?.ok) {
      this._mountCustomDashboard(this._result.custom_dashboard);
      return;
    }
    for (const element of host.querySelectorAll("*")) {
      if ("hass" in element) element.hass = this._hass;
    }
  }

  _nextFrame() {
    return new Promise((resolve) => window.requestAnimationFrame(resolve));
  }

  _isValidationMode() {
    return new URLSearchParams(window.location.search).has("urdash_validation");
  }

  _isValidationAutoPreview() {
    return new URLSearchParams(window.location.search).get("urdash_validation") === "preview";
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>${styles}</style>
      <main class="app-shell">
        <section class="workbench">
          <aside class="control-panel">
            <div class="brand-row">
              <div class="brand-mark">UD</div>
              <div>
                <h1>UrDash</h1>
                <p>Custom Lovelace dashboard designer</p>
              </div>
            </div>

            <label class="field">
              <span>Dashboard request</span>
              <textarea id="request" rows="7">${escapeHtml(this._currentRequest())}</textarea>
            </label>

            <div class="field">
              <span>Visual style</span>
              <div class="segmented" id="styleButtons">
                ${["modern", "minimal", "glass", "compact"].map((style) => `
                  <button class="${this._style === style ? "active" : ""}" data-style="${style}" type="button">${style}</button>
                `).join("")}
              </div>
            </div>

            <div class="field">
              <span>Generation mode</span>
              <div class="segmented three" id="modeButtons">
                <button class="${this._mode === "new_view" ? "active" : ""}" data-mode="new_view" type="button">new tab</button>
                <button class="${this._mode === "dashboard" ? "active" : ""}" data-mode="dashboard" type="button">full dashboard</button>
                <button class="${this._mode === "custom_dashboard" ? "active" : ""}" data-mode="custom_dashboard" type="button">AI custom</button>
              </div>
            </div>

            <label class="field ${this._mode === "new_view" ? "" : "hidden"}">
              <span>Reference tab</span>
              <select id="referenceView">
                ${this._referenceOptionsMarkup()}
              </select>
            </label>

            <label class="toggle-row">
              <input id="allowCustomCards" ${this._allowCustomCards ? "checked" : ""} type="checkbox" />
              <span>Use premium custom cards</span>
            </label>

            <section class="entity-panel">
              <div class="section-title entity-title">
                <span>Use</span>
                <h3>Devices and entities</h3>
                <strong>${this._selectedEntityCount()} / ${this._entities.length}</strong>
              </div>
              <div class="entity-actions">
                <input id="entityFilter" type="search" value="${escapeHtml(this._entityFilter)}" placeholder="Filter devices or entities" />
                <div>
                  <button id="selectAllEntities" type="button">All</button>
                  <button id="selectNoEntities" type="button">None</button>
                </div>
              </div>
              <div class="entity-groups">
                ${this._entitySelectionMarkup()}
              </div>
            </section>

            <button class="primary-action" id="generate" ${this._selectedEntityCount() ? "" : "disabled"} type="button">
              <span>*</span>
              Generate dashboard
            </button>
            ${this._selectedEntityCount() ? "" : '<p class="warning">Select at least one entity before generating.</p>'}

            <div class="stats-panel">
              <div class="stat">
                <span>HA</span>
                <strong>${this._entities.length}</strong>
                <span>entities</span>
              </div>
              <div class="ai-status">
                <strong>${this._settings.ai_enabled ? "AI ready" : "API key required"}</strong>
                <span>${escapeHtml(this._settings.ai_enabled ? this._settings.model : "Add an OpenAI API key in integration options")}</span>
              </div>
              <div class="domain-list">
                ${this._domainStats().map(([domain, count]) => `<span>${escapeHtml(domain)} ${count}</span>`).join("")}
              </div>
            </div>

            <section class="dependency-panel">
              <div class="section-title">
                <span>Pkg</span>
                <h3>Card packages</h3>
              </div>
              ${this._dependencyMarkup()}
            </section>
          </aside>

          <section class="preview-panel">
            <div class="preview-toolbar">
              <div>
                <h2>Preview</h2>
                <p>${escapeHtml(this._result?.summary || "Your generated dashboard will appear here.")}</p>
                ${this._result?.error ? `<p class="error-text">${escapeHtml(this._result.error)}</p>` : ""}
                ${this._result?.warning ? `<p class="warning">${escapeHtml(this._result.warning)}</p>` : ""}
                ${this._result?.mode === "new_view" ? '<p class="warning">Output is a new view/tab YAML snippet. Existing dashboard is not modified.</p>' : ""}
                ${this._result?.mode === "custom_dashboard" ? '<p class="warning">Output is a UrDash custom dashboard, not Lovelace YAML. It can be previewed in UrDash but cannot be added as a Lovelace tab.</p>' : ""}
              </div>
              <div class="toolbar-actions">
                <button class="icon-button" id="writePreview" ${this._canPreview() ? "" : "disabled"} title="Preview generated dashboard" type="button">Preview</button>
                <button class="icon-button" id="appendView" ${this._result?.view ? "" : "disabled"} title="Add as new Lovelace tab" type="button">Add tab</button>
                <button class="icon-button" id="copyYaml" ${this._resultText() ? "" : "disabled"} title="Copy output" type="button">Copy</button>
              </div>
            </div>

            ${this._previewResult ? `
              <div id="previewStatus" class="${this._previewResult.ok === null ? "status-box pending" : this._previewResult.ok ? "status-box success" : "status-box error"}">
                ${this._previewResult.ok === null
                  ? escapeHtml(this._previewResult.message || "Preparing preview.")
                  : this._previewResult.ok
                    ? escapeHtml(this._previewResult.message || "Preview rendered.")
                    : escapeHtml(this._previewResult.error || "Could not render the preview.")}
              </div>
            ` : ""}

            ${this._appendResult ? `
              <div class="${this._appendResult.ok ? "status-box success" : "status-box error"}">
                ${this._appendResult.ok
                  ? `Added "${escapeHtml(this._appendResult.title)}" as path "${escapeHtml(this._appendResult.path)}" in ${escapeHtml(this._appendResult.storage || "Lovelace storage")}. Reload Lovelace if it is not visible immediately.`
                  : escapeHtml(this._appendResult.error || "Could not add the tab.")}
              </div>
            ` : ""}

            <section class="real-preview-panel">
              <h3>Dashboard Preview</h3>
              <p>Use Preview to render Lovelace output with Home Assistant card helpers, or AI custom output with UrDash's native renderer. This does not write to any dashboard storage.</p>
              <div id="lovelacePreviewHost" class="lovelace-preview-host"></div>
            </section>

            <section class="yaml-panel">
              <div class="section-title">
                <span>Out</span>
                <h3>${escapeHtml(this._resultLabel())}</h3>
              </div>
              <pre>${escapeHtml(this._resultText() || "Generate a dashboard to see output.")}</pre>
            </section>
          </section>
        </section>
      </main>
    `;

    this.shadowRoot.querySelector("#generate").addEventListener("click", () => this._generate());
    this.shadowRoot.querySelector("#copyYaml").addEventListener("click", () => this._copyYaml());
    this.shadowRoot.querySelector("#appendView").addEventListener("click", () => this._appendView());
    this.shadowRoot.querySelector("#writePreview").addEventListener("click", () => this._writePreview());
    this.shadowRoot.querySelector("#allowCustomCards").addEventListener("change", (event) => {
      this._toggleCustomCards(event.target.checked);
    });
    this.shadowRoot.querySelector("#entityFilter").addEventListener("input", (event) => {
      this._setEntityFilter(event.target.value);
    });
    this.shadowRoot.querySelector("#selectAllEntities").addEventListener("click", () => this._selectAllEntities());
    this.shadowRoot.querySelector("#selectNoEntities").addEventListener("click", () => this._selectNoEntities());
    this.shadowRoot.querySelector(".entity-groups").addEventListener("change", (event) => {
      const target = event.target;
      if (target.matches("input[data-entity-id]")) {
        this._toggleEntity(target.dataset.entityId, target.checked);
      }
      if (target.matches("input[data-group-id]")) {
        this._toggleEntityGroup(target.dataset.groupId, target.checked);
      }
    });
    this.shadowRoot.querySelector("#styleButtons").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-style]");
      if (button) this._setStyle(button.dataset.style);
    });
    this.shadowRoot.querySelector("#modeButtons").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-mode]");
      if (button) this._setMode(button.dataset.mode);
    });
    this.shadowRoot.querySelector("#referenceView")?.addEventListener("change", (event) => {
      this._setReferenceView(event.target.value);
    });
  }

  _currentRequest() {
    const existing = this.shadowRoot.querySelector("#request")?.value;
    return existing || "Create a beautiful family dashboard with quick controls for lights, climate, doors, energy, and room-by-room status.";
  }

  _dependencyMarkup() {
    if (!this._allowCustomCards) {
      return '<p class="muted">Custom cards are disabled for this dashboard.</p>';
    }
    return this._resources.map((resource) => `
      <div class="dependency-row">
        <span class="${resource.installed ? "dot installed" : "dot"}"></span>
        <div>
          <strong>${escapeHtml(resource.name)} <em>${resource.installed ? "installed" : resource.checked ? "missing" : "not checked"}</em></strong>
          <p>${escapeHtml(resource.used_for || resource.usedFor || "")}</p>
          ${resource.installed ? "" : `<a class="install-link" href="${escapeHtml(resource.hacs_url || "")}" target="_blank" rel="noopener">Open in HACS</a>`}
        </div>
      </div>
    `).join("");
  }

  _entitySelectionMarkup() {
    if (!this._entities.length) {
      return '<p class="muted">No entities found.</p>';
    }
    const groups = this._deviceGroups();
    if (!groups.length) {
      return '<p class="muted">No entities match the current filter.</p>';
    }
    return groups.map((group) => {
      const selectedCount = group.entities.filter((entity) => this._selectedEntityIds.has(entity.entity_id)).length;
      const allSelected = selectedCount === group.entities.length;
      return `
        <details class="entity-group" open>
          <summary>
            <label>
              <input data-group-id="${escapeHtml(group.id)}" ${allSelected ? "checked" : ""} type="checkbox" />
              <span>
                <strong>${escapeHtml(group.title)}</strong>
                <em>${escapeHtml(group.area)} · ${selectedCount}/${group.entities.length}</em>
              </span>
            </label>
          </summary>
          <div class="entity-list">
            ${group.entities.map((entity) => `
              <label class="entity-row">
                <input data-entity-id="${escapeHtml(entity.entity_id)}" ${this._selectedEntityIds.has(entity.entity_id) ? "checked" : ""} type="checkbox" />
                <span>
                  <strong>${escapeHtml(this._entityLabel(entity))}</strong>
                  <em>${escapeHtml(entity.entity_id)}</em>
                </span>
              </label>
            `).join("")}
          </div>
        </details>
      `;
    }).join("");
  }

  _referenceOptionsMarkup() {
    if (!this._referenceViews.length) {
      return '<option value="">No UI-managed tabs found</option>';
    }
    return this._referenceViews.map((view) => `
      <option value="${escapeHtml(view.id)}" ${view.id === this._referenceViewId ? "selected" : ""}>
        ${escapeHtml(view.dashboard)} / ${escapeHtml(view.title)}
      </option>
    `).join("");
  }

  _renderError(error) {
    this.shadowRoot.innerHTML = `
      <style>${styles}</style>
      <main class="app-shell">
        <section class="error-panel">
          <h1>UrDash could not load</h1>
          <p>${escapeHtml(error?.message || String(error))}</p>
        </section>
      </main>
    `;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const VALIDATION_RESULT = {
  summary: "Validation fixture loaded from the UrDash frontend. No AI request was made.",
  engine: "validation",
  mode: "new_view",
  view: {
    title: "UrDash Validation",
    path: "urdash-validation",
    type: "sections",
    sections: [
      {
        title: "Home status",
        cards: [
          {
            type: "entities",
            title: "Overview",
            entities: [
              "input_boolean.urdash_demo_living_room",
              "input_boolean.urdash_demo_security",
              "sensor.urdash_demo_temperature",
            ],
          },
          {
            type: "tile",
            entity: "input_boolean.urdash_demo_living_room",
            name: "Living room",
            icon: "mdi:sofa",
          },
        ],
      },
      {
        title: "Climate and energy",
        cards: [
          {
            type: "gauge",
            entity: "sensor.urdash_demo_humidity",
            name: "Humidity",
            min: 0,
            max: 100,
          },
          {
            type: "history-graph",
            title: "Recent comfort",
            hours_to_show: 6,
            entities: [
              "sensor.urdash_demo_temperature",
              "sensor.urdash_demo_humidity",
            ],
          },
        ],
      },
    ],
  },
  yaml: `title: UrDash Validation
path: urdash-validation
type: sections
sections:
  - title: Home status
    cards:
      - type: entities
        title: Overview
        entities:
          - input_boolean.urdash_demo_living_room
          - input_boolean.urdash_demo_security
          - sensor.urdash_demo_temperature
      - type: tile
        entity: input_boolean.urdash_demo_living_room
        name: Living room
        icon: mdi:sofa
  - title: Climate and energy
    cards:
      - type: gauge
        entity: sensor.urdash_demo_humidity
        name: Humidity
        min: 0
        max: 100
      - type: history-graph
        title: Recent comfort
        hours_to_show: 6
        entities:
          - sensor.urdash_demo_temperature
          - sensor.urdash_demo_humidity`,
};

const styles = `
  :host {
    display: block;
    min-height: 100vh;
    color: #152126;
    font-family: var(--paper-font-body1_-_font-family, Inter, ui-sans-serif, system-ui, sans-serif);
  }

  * { box-sizing: border-box; }
  button, input, textarea, select { font: inherit; }
  h1, h2, h3, p { margin: 0; }

  .app-shell {
    min-height: 100vh;
    padding: 20px;
    background: linear-gradient(135deg, rgba(255,255,255,0.85), rgba(235,241,239,0.82)), #e7edee;
  }

  .workbench {
    display: grid;
    grid-template-columns: minmax(300px, 390px) minmax(0, 1fr);
    gap: 18px;
    max-width: 1480px;
    margin: 0 auto;
  }

  .control-panel, .preview-panel, .error-panel {
    background: rgba(255,255,255,0.82);
    border: 1px solid rgba(118,137,139,0.22);
    border-radius: 8px;
    box-shadow: 0 18px 42px rgba(35,54,59,0.12);
  }

  .control-panel {
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .brand-row, .preview-toolbar, .section-title, .stat, .dependency-row, .toggle-row {
    display: flex;
    align-items: center;
  }

  .brand-row { gap: 12px; }

  .brand-mark {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: 8px;
    background: #143d3a;
    color: #ffffff;
    font-size: 14px;
    font-weight: 900;
  }

  h1 { font-size: 24px; }
  .brand-row p, .preview-toolbar p, .muted, .dependency-row p, .ai-status span {
    color: #5d6f72;
    font-size: 13px;
  }

  .field { display: grid; gap: 8px; }
  .field.hidden { display: none; }
  .field > span {
    color: #314347;
    font-size: 13px;
    font-weight: 700;
  }

  input[type="search"], textarea, select {
    width: 100%;
    border: 1px solid #cad5d6;
    border-radius: 8px;
    padding: 12px;
    color: #1d2f33;
    background: #ffffff;
    line-height: 1.45;
  }

  textarea { resize: vertical; }

  input[type="checkbox"] {
    accent-color: #103c38;
  }

  .segmented {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
    padding: 4px;
    border: 1px solid #ccd7d8;
    border-radius: 8px;
    background: #f6f8f8;
  }

  .segmented.two {
    grid-template-columns: repeat(2, 1fr);
  }

  .segmented.three {
    grid-template-columns: repeat(3, 1fr);
  }

  .segmented button, .icon-button, .primary-action {
    border: 0;
    cursor: pointer;
  }

  .segmented button {
    min-height: 34px;
    border-radius: 6px;
    background: transparent;
    color: #3b4e52;
  }

  .segmented button.active {
    background: #ffffff;
    color: #103c38;
    box-shadow: 0 1px 4px rgba(27,50,55,0.16);
  }

  .toggle-row {
    gap: 10px;
    color: #25383c;
    font-size: 14px;
    font-weight: 700;
  }

  .primary-action {
    min-height: 44px;
    display: inline-flex;
    gap: 9px;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    background: #103c38;
    color: #ffffff;
    font-weight: 800;
  }

  .primary-action:disabled, .icon-button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .stats-panel, .dependency-panel, .entity-panel, .yaml-panel {
    border: 1px solid #d7e0e1;
    border-radius: 8px;
    padding: 14px;
    background: rgba(248,250,250,0.78);
  }

  .stat { gap: 8px; }
  .stat strong { font-size: 24px; }

  .ai-status {
    display: grid;
    gap: 3px;
    margin-top: 10px;
  }

  .ai-status strong {
    color: #18383a;
    font-size: 13px;
  }

  .warning, .error-text {
    margin-top: 4px;
    color: #9a5b13;
  }

  .error-text {
    color: #9b2f2f;
  }

  .domain-list {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    margin-top: 12px;
  }

  .domain-list span {
    padding: 5px 8px;
    border-radius: 6px;
    background: #e7eeee;
    color: #385054;
    font-size: 12px;
  }

  .dependency-panel { display: grid; gap: 12px; }
  .section-title { gap: 7px; }
  .entity-title {
    justify-content: space-between;
  }

  .entity-title h3 {
    margin-right: auto;
  }

  .entity-title strong {
    color: #31565c;
    font-size: 12px;
  }

  .section-title h3 { font-size: 15px; }
  .dependency-row { gap: 10px; margin-top: 10px; }
  .dependency-row strong { font-size: 13px; }

  .entity-panel {
    display: grid;
    gap: 10px;
  }

  .entity-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
  }

  .entity-actions > div {
    display: flex;
    gap: 6px;
  }

  .entity-actions button {
    min-height: 36px;
    border: 0;
    border-radius: 8px;
    padding: 0 10px;
    background: #e8eeee;
    color: #18383a;
    cursor: pointer;
    font-weight: 800;
  }

  .entity-groups {
    max-height: 330px;
    display: grid;
    gap: 8px;
    overflow: auto;
    padding-right: 2px;
  }

  .entity-group {
    border: 1px solid #d8e2e3;
    border-radius: 8px;
    background: #ffffff;
  }

  .entity-group summary {
    cursor: pointer;
    list-style: none;
    padding: 9px 10px;
  }

  .entity-group summary::-webkit-details-marker {
    display: none;
  }

  .entity-group summary label, .entity-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 8px;
    align-items: start;
  }

  .entity-group strong, .entity-row strong {
    display: block;
    color: #243b3f;
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .entity-group em, .entity-row em {
    display: block;
    color: #637579;
    font-size: 11px;
    font-style: normal;
    overflow-wrap: anywhere;
  }

  .entity-list {
    display: grid;
    gap: 7px;
    border-top: 1px solid #e4eaeb;
    padding: 9px 10px 10px;
  }

  .entity-row {
    cursor: pointer;
  }

  .dependency-row em {
    color: #5d6f72;
    font-size: 11px;
    font-style: normal;
    font-weight: 700;
    margin-left: 4px;
    text-transform: uppercase;
  }

  .install-link {
    display: inline-flex;
    margin-top: 4px;
    color: #0b6f7f;
    font-size: 12px;
    font-weight: 800;
    text-decoration: none;
  }

  .install-link:hover {
    text-decoration: underline;
  }

  .dot {
    width: 10px;
    height: 10px;
    flex: 0 0 auto;
    border-radius: 999px;
    background: #c98d35;
  }

  .dot.installed { background: #28835f; }

  .preview-panel {
    min-width: 0;
    padding: 18px;
    display: grid;
    gap: 16px;
  }

  .preview-toolbar {
    justify-content: space-between;
    gap: 14px;
  }

  .toolbar-actions {
    display: flex;
    gap: 8px;
  }

  .icon-button {
    display: grid;
    place-items: center;
    min-width: 48px;
    height: 40px;
    border-radius: 8px;
    background: #e8eeee;
    color: #18383a;
    padding: 0 10px;
  }

  .status-box {
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 13px;
    font-weight: 700;
  }

  .status-box.success {
    background: #e7f4ed;
    color: #1d6a4d;
  }

  .status-box.pending {
    background: #e8eeee;
    color: #36555a;
  }

  .status-box.error {
    background: #f8e8e6;
    color: #9b2f2f;
  }

  .real-preview-panel {
    border: 1px solid #d7e0e1;
    border-radius: 8px;
    padding: 14px;
    background: rgba(248,250,250,0.78);
    display: grid;
    gap: 10px;
  }

  .real-preview-panel p {
    color: #5d6f72;
    font-size: 13px;
  }

  .lovelace-preview-host {
    width: 100%;
    min-height: 320px;
    border: 1px solid #cad5d6;
    border-radius: 8px;
    background: #ffffff;
    padding: 16px;
    overflow: auto;
  }

  .lovelace-preview-title {
    margin-bottom: 14px;
    color: #172c31;
    font-size: 20px;
    font-weight: 800;
  }

  .lovelace-sections-preview {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 14px;
    align-items: start;
  }

  .lovelace-section {
    display: grid;
    gap: 12px;
    min-width: 0;
  }

  .lovelace-section h4 {
    margin: 0;
    color: #25383c;
    font-size: 14px;
  }

  .lovelace-card-grid {
    columns: 320px;
    column-gap: 14px;
  }

  .lovelace-panel-preview {
    display: grid;
    gap: 14px;
  }

  .lovelace-card-shell {
    display: block;
    min-width: 0;
    margin-bottom: 14px;
    break-inside: avoid;
  }

  .lovelace-card-shell > * {
    display: block;
    width: 100%;
  }

  .lovelace-render-error {
    border: 1px solid #efcbc6;
    border-radius: 8px;
    padding: 12px;
    background: #fff4f2;
    color: #9b2f2f;
    font-size: 13px;
    font-weight: 700;
  }

  .custom-dashboard {
    --custom-bg: radial-gradient(circle at 18% 14%, rgba(31,138,112,0.26), transparent 26%),
      radial-gradient(circle at 86% 10%, rgba(215,138,63,0.2), transparent 24%),
      linear-gradient(145deg, #ecf8f4, #f8f3ea 48%, #e8f0f5);
    --custom-fg: #112a2d;
    --custom-muted: #587074;
    --custom-panel: rgba(255,255,255,0.64);
    display: grid;
    gap: 22px;
    min-height: 520px;
    border-radius: 8px;
    padding: 22px;
    background: var(--custom-bg);
    color: var(--custom-fg);
    position: relative;
    overflow: hidden;
  }

  .custom-dashboard::before {
    content: "";
    position: absolute;
    inset: 14px;
    border: 1px solid rgba(255,255,255,0.55);
    border-radius: 8px;
    pointer-events: none;
  }

  .custom-dashboard-aurora {
    --custom-bg: linear-gradient(135deg, #edf8f5, #f7efe6);
    --custom-fg: #102b2f;
    --custom-muted: #5a6f73;
  }

  .custom-dashboard-calm {
    --custom-bg: linear-gradient(135deg, #f4f7f8, #e8f0ed);
    --custom-fg: #1d3034;
    --custom-muted: #65777a;
  }

  .custom-dashboard-graphite {
    --custom-bg: linear-gradient(135deg, #172326, #283338);
    --custom-fg: #eef7f4;
    --custom-muted: #b6c4c5;
    --custom-panel: rgba(255,255,255,0.1);
  }

  .custom-dashboard-sunrise {
    --custom-bg: linear-gradient(135deg, #fff6e8, #eaf7f2);
    --custom-fg: #2a2c26;
    --custom-muted: #766f61;
  }

  .custom-dashboard-quiet {
    --custom-bg: linear-gradient(135deg, #fafaf7, #f2f5f3);
    --custom-fg: #202728;
    --custom-muted: #6d7675;
    --custom-panel: rgba(255,255,255,0.42);
    gap: 18px;
    padding: 24px;
  }

  .custom-dashboard-quiet::before {
    inset: 18px;
    border-color: rgba(36,45,45,0.08);
  }

  .custom-dashboard-hero {
    display: grid;
    gap: 8px;
    position: relative;
    z-index: 1;
  }

  .custom-dashboard-hero h3 {
    color: var(--custom-fg);
    max-width: 720px;
    font-size: 34px;
    line-height: 1.04;
  }

  .custom-dashboard-quiet .custom-dashboard-hero {
    grid-template-columns: minmax(0, 1fr);
    border-bottom: 1px solid rgba(32,39,40,0.1);
    padding-bottom: 14px;
  }

  .custom-dashboard-quiet .custom-dashboard-hero h3 {
    max-width: none;
    font-size: 28px;
    font-weight: 850;
    letter-spacing: 0;
  }

  .custom-dashboard-quiet .custom-dashboard-hero p {
    font-size: 13px;
  }

  .custom-quiet-health {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border-bottom: 1px solid rgba(32,39,40,0.1);
    padding-bottom: 14px;
  }

  .custom-quiet-signal {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    gap: 5px 8px;
    align-items: center;
    padding-right: 12px;
  }

  .custom-quiet-signal ha-icon {
    width: 18px;
    height: 18px;
    color: #1f8a70;
  }

  .custom-quiet-signal span {
    color: var(--custom-fg);
    font-size: 12px;
    font-weight: 850;
  }

  .custom-quiet-signal strong {
    grid-column: 2;
    color: var(--custom-muted);
    font-size: 11px;
    font-weight: 650;
  }

  .custom-dashboard-hero p,
  .custom-section-header p,
  .custom-card-header p,
  .custom-metric span,
  .custom-empty {
    color: var(--custom-muted);
  }

  .custom-dashboard-section {
    display: grid;
    gap: 12px;
    position: relative;
    z-index: 1;
  }

  .custom-section-header h4 {
    margin: 0;
    color: var(--custom-fg);
    font-size: 18px;
  }

  .custom-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 14px;
  }

  .custom-layout-feature .custom-card-grid {
    grid-template-columns: minmax(260px, 1.4fr) repeat(auto-fit, minmax(210px, 1fr));
  }

  .custom-layout-dense .custom-card-grid {
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  }

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

  .custom-dashboard-quiet .custom-section-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: end;
  }

  .custom-dashboard-quiet .custom-section-header h4 {
    font-size: 14px;
    text-transform: uppercase;
  }

  .custom-dashboard-quiet .custom-card-grid {
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 0;
    border-top: 1px solid rgba(32,39,40,0.1);
  }

  .custom-dashboard-quiet .custom-card {
    min-height: 0;
    border: 0;
    border-bottom: 1px solid rgba(32,39,40,0.1);
    border-radius: 0;
    padding: 14px 0;
    background: transparent;
    box-shadow: none;
    backdrop-filter: none;
  }

  .custom-dashboard-quiet .custom-card::after {
    display: none;
  }

  .custom-dashboard-quiet .custom-card-header {
    grid-template-columns: 24px minmax(0, 1fr);
  }

  .custom-dashboard-quiet .custom-card-header ha-icon {
    width: 24px;
    height: 24px;
    background: transparent;
    color: var(--accent);
    box-shadow: none;
  }

  .custom-dashboard-quiet .custom-card-header h5 {
    font-size: 14px;
  }

  .custom-dashboard-quiet .custom-card-header p {
    font-size: 11px;
  }

  .custom-dashboard-quiet .custom-card-orbit {
    min-height: 220px;
  }

  .custom-dashboard-quiet .custom-card-metric {
    min-height: 160px;
    place-content: center;
    text-align: center;
  }

  .custom-card::after {
    content: "";
    position: absolute;
    inset: auto 12px 12px auto;
    width: 54px;
    height: 54px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 24%, transparent);
    pointer-events: none;
  }

  .custom-card-hero, .custom-card-orbit, .custom-card-scene {
    min-height: 210px;
  }

  .custom-card-header {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
  }

  .custom-card-header ha-icon {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 8px;
    background: var(--accent);
    color: #ffffff;
    box-shadow: 0 10px 22px color-mix(in srgb, var(--accent) 36%, transparent);
  }

  .custom-card-header h5 {
    margin: 0;
    color: var(--custom-fg);
    font-size: 15px;
  }

  .custom-card-header p {
    margin: 3px 0 0;
    font-size: 12px;
  }

  .custom-metric {
    display: grid;
    gap: 4px;
    align-self: end;
  }

  .custom-metric strong {
    color: var(--custom-fg);
    font-size: 40px;
    line-height: 1;
  }

  .custom-dashboard-quiet .custom-metric {
    place-items: center;
  }

  .custom-dashboard-quiet .custom-metric strong {
    font-size: 56px;
    font-weight: 780;
  }

  .custom-dashboard-quiet .custom-metric span {
    font-size: 12px;
  }

  .custom-hero-states {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-self: end;
  }

  .custom-state-pill {
    border-radius: 999px;
    padding: 7px 10px;
    background: rgba(255,255,255,0.58);
    color: var(--custom-fg);
    font-size: 12px;
    font-weight: 800;
  }

  .custom-orbit {
    min-height: 178px;
    position: relative;
  }

  .custom-orbit-core {
    position: absolute;
    inset: 50% auto auto 50%;
    display: grid;
    place-items: center;
    width: 104px;
    height: 104px;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, white);
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 16%, rgba(255,255,255,0.74));
    transform: translate(-50%, -50%);
  }

  .custom-dashboard-quiet .custom-orbit-core {
    width: 118px;
    height: 118px;
    border-color: rgba(31,138,112,0.22);
    background: transparent;
  }

  .custom-dashboard-quiet .custom-orbit-core strong {
    font-size: 34px;
    font-weight: 780;
  }

  .custom-dashboard-quiet .custom-orbit-satellite {
    border: 1px solid rgba(32,39,40,0.1);
    background: rgba(255,255,255,0.72);
  }

  .custom-orbit-core strong {
    color: var(--custom-fg);
    font-size: 28px;
    line-height: 1;
  }

  .custom-orbit-core span {
    color: var(--custom-muted);
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .custom-orbit-satellite {
    position: absolute;
    left: calc(50% + var(--x));
    top: calc(50% + var(--y));
    max-width: 118px;
    border-radius: 999px;
    padding: 6px 9px;
    background: rgba(255,255,255,0.72);
    color: var(--custom-fg);
    font-size: 10px;
    font-weight: 800;
    transform: translate(-50%, -50%);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .custom-scene {
    display: grid;
    gap: 14px;
    align-self: end;
  }

  .custom-scene > p {
    max-width: 420px;
    color: var(--custom-fg);
    font-size: 22px;
    font-weight: 900;
    line-height: 1.1;
  }

  .custom-action-row, .custom-control-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 9px;
  }

  .custom-dashboard-quiet .custom-action-row,
  .custom-dashboard-quiet .custom-control-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0;
  }

  .custom-control-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  }

  .custom-action {
    min-height: 58px;
    display: grid;
    gap: 3px;
    border: 1px solid rgba(255,255,255,0.45);
    border-radius: 8px;
    padding: 9px 11px;
    background: rgba(255,255,255,0.62);
    color: var(--custom-fg);
    cursor: pointer;
    text-align: left;
  }

  .custom-dashboard-quiet .custom-action {
    min-height: 46px;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    border: 0;
    border-top: 1px solid rgba(32,39,40,0.08);
    border-radius: 0;
    padding: 9px 0;
    background: transparent;
  }

  .custom-dashboard-quiet .custom-action span {
    font-size: 12px;
  }

  .custom-dashboard-quiet .custom-action strong {
    font-size: 11px;
  }

  .custom-action:disabled {
    cursor: default;
    opacity: 0.78;
  }

  .custom-action span {
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .custom-action strong {
    font-size: 13px;
    text-transform: uppercase;
  }

  .custom-timeline {
    display: grid;
    gap: 10px;
  }

  .custom-timeline-item {
    display: grid;
    grid-template-columns: 12px minmax(0, 1fr);
    gap: 9px;
    align-items: start;
  }

  .custom-timeline-item span {
    width: 10px;
    height: 10px;
    margin-top: 4px;
    border-radius: 999px;
    background: var(--accent);
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 18%, transparent);
  }

  .custom-timeline-item p {
    color: var(--custom-fg);
    font-size: 12px;
  }

  .custom-dashboard-quiet .custom-timeline {
    gap: 0;
    border-top: 1px solid rgba(32,39,40,0.1);
  }

  .custom-dashboard-quiet .custom-timeline-item {
    border-bottom: 1px solid rgba(32,39,40,0.08);
    padding: 10px 0;
  }

  .custom-entity-list {
    display: grid;
    gap: 9px;
  }

  .custom-entity-line {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    color: var(--custom-fg);
    font-size: 13px;
  }

  .custom-entity-line span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .custom-entity-line strong {
    white-space: nowrap;
  }

  .yaml-panel {
    display: grid;
    gap: 10px;
    min-width: 0;
  }

  pre {
    max-height: 340px;
    margin: 0;
    overflow: auto;
    border-radius: 8px;
    padding: 14px;
    background: #152326;
    color: #e8f2ee;
    font-size: 12px;
    line-height: 1.5;
  }

  .error-panel {
    max-width: 760px;
    margin: 0 auto;
    padding: 22px;
  }

  .spin {
    display: inline-block;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 980px) {
    .workbench { grid-template-columns: 1fr; }
  }

  @media (max-width: 560px) {
    .app-shell { padding: 10px; }
    .segmented { grid-template-columns: repeat(2, 1fr); }
  }
`;

customElements.define("urdash-panel", UrDashPanel);
