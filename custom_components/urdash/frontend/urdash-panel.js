const DEFAULT_STYLE_PRESETS = [
  ["auto", "AI decides", "Choose the visual language from the request and device context."],
  ["minimal", "Minimal", "Restrained typography, generous space, and essential controls."],
  ["aurora", "Aurora", "Luminous color, atmospheric depth, and refined motion."],
  ["glassmorphism", "Glassmorphism", "Translucent layers, subtle borders, and dimensional light."],
  ["bento", "Bento", "Clear modular hierarchy with varied scale and strong scanning."],
  ["editorial", "Editorial", "Expressive type, asymmetric rhythm, and information-led composition."],
  ["material", "Material", "Familiar surfaces, clear elevation, and direct interaction states."],
  ["neobrutalist", "Neo-brutalist", "Bold contrast, decisive outlines, and intentionally direct controls."],
  ["futuristic", "Futuristic", "Technical precision, dark depth, telemetry, and controlled glow."],
  ["organic", "Organic", "Soft geometry, natural color, and calm spatial flow."],
  ["monochrome", "Monochrome", "Tonal hierarchy, graphic contrast, and minimal color dependence."],
  ["luxury", "Luxury", "Quiet drama, polished detail, and premium restrained accents."],
  ["playful", "Playful", "Friendly color, expressive shapes, and lively purposeful motion."],
].map(([id, label, description]) => ({ id, label, description }));

class UrDashPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._entities = [];
    this._settings = {
      ai_enabled: false,
      ai_provider: "openai",
      model: "",
      default_theme: "aurora",
      default_height_mode: "auto",
      style_presets: [],
    };
    this._style = "auto";
    this._theme = "aurora";
    this._heightMode = "auto";
    this._result = null;
    this._requestDraft = "Create a beautiful and useful room control card that combines lights, climate, covers, and key sensors.";
    this._generating = false;
    this._generationError = "";
    this._selectedEntityIds = new Set();
    this._entityFilter = "";
    this._areaFilter = "all";
    this._selectedOnly = false;
    this._previewSize = "wide";
    this._previewMountId = 0;
    this._showConfig = false;
    this._installOpen = false;
    this._installLoading = false;
    this._installError = "";
    this._installTargets = [];
    this._installDashboardId = "";
    this._installViewId = "";
    this._installSuccess = null;
    this._loaded = false;
    this._loading = false;
    this._loadRetryTimer = null;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._loaded && !this._loading) {
      this._load();
    } else {
      this._refreshPreviewHass();
    }
  }

  async _load() {
    this._loading = true;
    this._render();
    try {
      const [entityPayload, settingsPayload] = await this._loadBackendData();
      this._entities = entityPayload.entities || [];
      this._selectedEntityIds = new Set(this._entities.map((entity) => entity.entity_id).filter(Boolean));
      this._settings = { ...this._settings, ...settingsPayload };
      this._theme = this._settings.default_theme || this._theme;
      this._heightMode = this._settings.default_height_mode || this._heightMode;
      if (this._isValidationMode()) this._result = VALIDATION_RESULT;
      this._loaded = true;
      this._render();
      if (this._result?.card_config) await this._mountPreview();
    } catch (error) {
      this._renderError(error);
      if (this._isUnknownCommandError(error)) {
        window.clearTimeout(this._loadRetryTimer);
        this._loadRetryTimer = window.setTimeout(() => {
          if (!this._loaded && !this._loading && this.isConnected) this._load();
        }, 5000);
      }
    } finally {
      this._loading = false;
    }
  }

  disconnectedCallback() {
    window.clearTimeout(this._loadRetryTimer);
  }

  async _loadBackendData() {
    const delays = [0, 250, 750, 1500, 3000];
    let lastError;
    for (const delay of delays) {
      if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
      try {
        return await Promise.all([
          this._hass.connection.sendMessagePromise({ type: "urdash/entities" }),
          this._hass.connection.sendMessagePromise({ type: "urdash/settings" }),
        ]);
      } catch (error) {
        lastError = error;
        if (!this._isUnknownCommandError(error)) throw error;
      }
    }
    throw lastError;
  }

  _isUnknownCommandError(error) {
    const message = `${error?.code || ""} ${error?.message || error || ""}`.toLowerCase();
    return message.includes("unknown_command") || message.includes("unknown command");
  }

  async _generate() {
    this._captureDraft();
    const request = this._requestDraft.trim();
    if (!request || !this._selectedEntityCount()) return;

    this._generating = true;
    this._generationError = "";
    this._render();

    try {
      this._result = await this._hass.connection.sendMessagePromise({
        type: "urdash/generate",
        request,
        style: this._style,
        theme: this._theme,
        height_mode: this._heightMode,
        selected_entity_ids: this._selectedEntityIdsList(),
      });
      if (this._result?.error) this._generationError = this._result.error;
      this._render();
      if (this._result?.card_config) {
        await this._nextFrame();
        await this._mountPreview();
      }
    } catch (error) {
      this._generationError = error?.message || String(error);
    } finally {
      this._generating = false;
      this._render();
      if (this._result?.card_config) await this._mountPreview();
    }
  }

  async _copyYaml() {
    const output = this._result?.yaml || "";
    if (!output) return;
    await navigator.clipboard.writeText(output);
    this._flashButton("#copyYaml", "Copied");
  }

  async _copyJson() {
    const output = this._result?.json || "";
    if (!output) return;
    await navigator.clipboard.writeText(output);
    this._flashButton("#copyJson", "Copied");
  }

  async _openInstall() {
    if (!this._result?.candidate_id) return;
    this._captureDraft();
    this._installOpen = true;
    this._installLoading = true;
    this._installError = "";
    this._installSuccess = null;
    this._render();
    try {
      const result = await this._hass.connection.sendMessagePromise({ type: "urdash/lovelace/targets" });
      this._installTargets = (result.dashboards || []).filter((target) => target.writable && target.views?.length);
      if (!this._installTargets.length) {
        this._installError = "No writable UI-managed dashboard with a visible view was found.";
      } else {
        this._installDashboardId = this._installTargets[0].id;
        this._installViewId = this._installTargets[0].views[0].id;
      }
    } catch (error) {
      this._installError = error?.message || String(error);
    } finally {
      this._installLoading = false;
      this._render();
    }
  }

  _closeInstall() {
    this._captureDraft();
    this._installOpen = false;
    this._render();
  }

  _setInstallDashboard(dashboardId) {
    this._captureDraft();
    this._installDashboardId = dashboardId;
    this._installViewId = this._selectedInstallDashboard()?.views?.[0]?.id || "";
    this._installError = "";
    this._render();
  }

  _selectedInstallDashboard() {
    return this._installTargets.find((target) => target.id === this._installDashboardId);
  }

  async _installCard() {
    const dashboard = this._selectedInstallDashboard();
    if (!dashboard || !this._installViewId || !this._result?.candidate_id) return;
    this._captureDraft();
    this._installLoading = true;
    this._installError = "";
    this._render();
    try {
      this._installSuccess = await this._hass.connection.sendMessagePromise({
        type: "urdash/lovelace/install",
        candidate_id: this._result.candidate_id,
        dashboard_id: dashboard.id,
        view_id: this._installViewId,
        expected_revision: dashboard.revision,
      });
    } catch (error) {
      this._installError = error?.message || String(error);
    } finally {
      this._installLoading = false;
      this._render();
    }
  }

  _installDialogMarkup() {
    if (!this._installOpen) return "";
    const dashboard = this._selectedInstallDashboard();
    if (this._installSuccess) {
      return `<div class="modal-backdrop" role="presentation">
        <section class="install-dialog" role="dialog" aria-modal="true" aria-labelledby="installTitle">
          <div class="success-mark"><ha-icon icon="mdi:check"></ha-icon></div>
          <div class="install-success">
            <h2 id="installTitle">Card added</h2>
            <p>The generated card is now the last card in the selected Lovelace view.</p>
          </div>
          <div class="dialog-actions">
            <button class="secondary-action" data-close-install type="button">Done</button>
            <a class="install-confirm" href="${escapeHtml(this._installSuccess.url)}"><ha-icon icon="mdi:open-in-new"></ha-icon>Open dashboard</a>
          </div>
        </section>
      </div>`;
    }
    return `<div class="modal-backdrop" role="presentation">
      <section class="install-dialog" role="dialog" aria-modal="true" aria-labelledby="installTitle">
        <header class="dialog-header">
          <div>
            <span>Install card</span>
            <h2 id="installTitle">Add to Lovelace</h2>
          </div>
          <button class="icon-action" data-close-install title="Close" type="button"><ha-icon icon="mdi:close"></ha-icon></button>
        </header>
        ${this._installLoading && !this._installTargets.length ? `<div class="target-loading"><span class="spin-dot"></span>Loading dashboards</div>` : `
          <div class="install-fields">
            <label class="field">
              <span>Dashboard</span>
              <select id="installDashboard" ${this._installTargets.length ? "" : "disabled"}>
                ${this._installTargets.map((target) => `<option value="${escapeHtml(target.id)}" ${target.id === this._installDashboardId ? "selected" : ""}>${escapeHtml(target.title)}</option>`).join("")}
              </select>
            </label>
            <label class="field">
              <span>View</span>
              <select id="installView" ${dashboard?.views?.length ? "" : "disabled"}>
                ${(dashboard?.views || []).map((view) => `<option value="${escapeHtml(view.id)}" ${view.id === this._installViewId ? "selected" : ""}>${escapeHtml(view.title)}</option>`).join("")}
              </select>
            </label>
          </div>
          <div class="placement-summary">
            <ha-icon icon="mdi:format-vertical-align-bottom"></ha-icon>
            <span>The card will be appended after the existing cards. Nothing will be replaced or reordered.</span>
          </div>
        `}
        ${this._installError ? `<div class="generation-error install-error" role="alert"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><span>${escapeHtml(this._installError)}</span></div>` : ""}
        <div class="dialog-actions">
          <button class="secondary-action" data-close-install type="button">Cancel</button>
          <button class="install-confirm" id="confirmInstall" ${dashboard && this._installViewId && !this._installLoading ? "" : "disabled"} type="button">
            <ha-icon icon="${this._installLoading ? "mdi:loading" : "mdi:view-dashboard-plus-outline"}" class="${this._installLoading ? "spin" : ""}"></ha-icon>
            ${this._installLoading ? "Adding card" : "Add card"}
          </button>
        </div>
      </section>
    </div>`;
  }

  _flashButton(selector, text) {
    const button = this.shadowRoot.querySelector(selector);
    if (!button) return;
    const original = button.textContent;
    button.textContent = text;
    window.setTimeout(() => {
      const current = this.shadowRoot.querySelector(selector);
      if (current) current.textContent = original;
    }, 1200);
  }

  async _mountPreview() {
    const mountId = ++this._previewMountId;
    const host = this.shadowRoot.querySelector("#previewHost");
    if (!host) return;
    host.innerHTML = "";
    if (!this._result?.card_config) {
      host.appendChild(this._emptyPreview("Generate a card to see the real UrDash renderer."));
      return;
    }
    await this._loadUrDashCard();
    if (mountId !== this._previewMountId) return;
    const card = document.createElement("urdash-card");
    card.setConfig({ ...this._result.card_config, preview: true });
    card.hass = this._hass;
    host.appendChild(card);
  }

  async _loadUrDashCard() {
    if (customElements.get("urdash-card")) return;
    await import("/urdash/static/urdash-custom-card.js?v=20260712.7");
  }

  _refreshPreviewHass() {
    const card = this.shadowRoot.querySelector("urdash-card");
    if (card) card.hass = this._hass;
  }

  _setStyle(style) {
    this._captureDraft();
    this._style = style;
    this._render();
  }

  _setHeightMode(heightMode) {
    this._captureDraft();
    this._heightMode = heightMode;
    this._render();
  }

  _setAreaFilter(area) {
    this._captureDraft();
    this._areaFilter = area;
    this._render();
  }

  _setSelectedOnly(selectedOnly) {
    this._captureDraft();
    this._selectedOnly = selectedOnly;
    this._render();
  }

  _setPreviewSize(size) {
    this._captureDraft();
    this._previewSize = size;
    this._render();
  }

  _setEntityFilter(value) {
    this._entityFilter = value;
    this._refreshEntitySelectionMarkup();
  }

  _toggleEntity(entityId, checked) {
    this._captureDraft();
    if (checked) this._selectedEntityIds.add(entityId);
    else this._selectedEntityIds.delete(entityId);
    this._render();
  }

  _toggleEntityGroup(groupId, checked) {
    this._captureDraft();
    const group = this._entityGroups().find((item) => item.id === groupId);
    if (!group) return;
    for (const entity of group.entities) {
      if (checked) this._selectedEntityIds.add(entity.entity_id);
      else this._selectedEntityIds.delete(entity.entity_id);
    }
    this._render();
  }

  _selectAllEntities() {
    this._captureDraft();
    this._selectedEntityIds = new Set(this._entities.map((entity) => entity.entity_id).filter(Boolean));
    this._render();
  }

  _selectNoEntities() {
    this._captureDraft();
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

  _entityGroups() {
    const filter = this._entityFilter.trim().toLowerCase();
    const groups = new Map();
    for (const entity of this._entities) {
      if (this._areaFilter !== "all" && (entity.area_name || "No area") !== this._areaFilter) continue;
      if (this._selectedOnly && !this._selectedEntityIds.has(entity.entity_id)) continue;
      const groupId = entity.device_id || `domain:${entity.domain || entity.entity_id?.split(".")[0] || "other"}`;
      const groupTitle = entity.device_name || this._domainTitle(entity.domain || entity.entity_id?.split(".")[0]);
      const area = entity.area_name || "No area";
      if (!groups.has(groupId)) {
        groups.set(groupId, { id: groupId, title: groupTitle || "Other", area, entities: [] });
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
    return [entity.entity_id, this._entityLabel(entity), group.title, group.area, entity.domain]
      .some((value) => String(value || "").toLowerCase().includes(filter));
  }

  _entityLabel(entity) {
    return entity.name || entity.attributes?.friendly_name || entity.entity_id;
  }

  _domainTitle(domain) {
    if (!domain) return "Other";
    return domain.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
  }

  _domainStats() {
    const counts = new Map();
    for (const entity of this._entities) {
      const domain = entity.entity_id?.split(".")[0];
      if (domain) counts.set(domain, (counts.get(domain) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }

  _areas() {
    return [...new Set(this._entities.map((entity) => entity.area_name || "No area"))]
      .sort((a, b) => a.localeCompare(b));
  }

  _stylePresets() {
    return this._settings.style_presets?.length ? this._settings.style_presets : DEFAULT_STYLE_PRESETS;
  }

  _selectedStyle() {
    return this._stylePresets().find((preset) => preset.id === this._style) || this._stylePresets()[0];
  }

  _captureDraft() {
    const request = this.shadowRoot?.querySelector("#request");
    if (request) this._requestDraft = request.value;
  }

  _refreshEntitySelectionMarkup() {
    const groups = this.shadowRoot.querySelector(".entity-groups");
    if (groups) groups.innerHTML = this._entitySelectionMarkup();
  }

  _render() {
    const hasResult = Boolean(this._result?.card_config);
    const canGenerate = Boolean(this._requestDraft.trim() && this._selectedEntityCount() && !this._generating);
    const style = this._selectedStyle();
    this.shadowRoot.innerHTML = `
      <style>${styles}</style>
      <main class="studio">
        <aside class="composer">
          <header class="brand">
            <div class="brand-mark"><ha-icon icon="mdi:creation-outline"></ha-icon></div>
            <div>
              <h1>Card Studio</h1>
              <p>UrDash generation console</p>
            </div>
            <span class="ready-state ${this._settings.ai_enabled ? "ready" : ""}">
              ${this._settings.ai_enabled ? "AI ready" : "API key required"}
            </span>
          </header>

          <section class="composer-section devices-section">
            <div class="panel-title">
              <div>
                <span>01</span>
                <h2>Choose devices</h2>
              </div>
              <strong>${this._selectedEntityCount()} of ${this._entities.length}</strong>
            </div>
            <div class="entity-actions">
              <label class="search-control">
                <ha-icon icon="mdi:magnify"></ha-icon>
                <input id="entityFilter" type="search" value="${escapeHtml(this._entityFilter)}" placeholder="Search devices, areas, entities" />
              </label>
              <div>
                <button id="selectAllEntities" title="Select all entities" type="button">All</button>
                <button id="selectNoEntities" title="Clear selection" type="button">Clear</button>
              </div>
            </div>
            <div class="entity-filters">
              <label>
                <span>Area</span>
                <select id="areaFilter">
                  <option value="all">All areas</option>
                  ${this._areas().map((area) => `<option value="${escapeHtml(area)}" ${this._areaFilter === area ? "selected" : ""}>${escapeHtml(area)}</option>`).join("")}
                </select>
              </label>
              <label class="selected-toggle">
                <input id="selectedOnly" type="checkbox" ${this._selectedOnly ? "checked" : ""} />
                <span>Selected only</span>
              </label>
            </div>
            <div class="entity-groups">
              ${this._entitySelectionMarkup()}
            </div>
          </section>

          <section class="composer-section direction-section">
            <div class="panel-title">
              <div>
                <span>02</span>
                <h2>Set the direction</h2>
              </div>
            </div>
            <label class="field">
              <span>Visual style <em>Optional</em></span>
              <select id="styleSelect">
                ${this._stylePresets().map((preset) => `<option value="${escapeHtml(preset.id)}" ${this._style === preset.id ? "selected" : ""}>${escapeHtml(preset.label)}</option>`).join("")}
              </select>
            </label>
            <div class="style-summary" data-style="${escapeHtml(style.id)}">
              <span class="style-swatch"></span>
              <p>${escapeHtml(style.description)}</p>
            </div>
            <label class="field prompt-field">
              <span>What should this card do?</span>
              <textarea id="request" rows="6" placeholder="Describe the information, controls, priorities, and feeling of the card.">${escapeHtml(this._requestDraft)}</textarea>
            </label>
            <details class="advanced-options">
              <summary>Advanced</summary>
              <div class="field">
                <span>Card height</span>
                <div class="segmented three" id="heightButtons">
                  ${["auto", "viewport", "fixed"].map((mode) => `
                    <button class="${this._heightMode === mode ? "active" : ""}" data-height-mode="${mode}" type="button">${mode}</button>
                  `).join("")}
                </div>
              </div>
            </details>
          </section>

          ${this._generationError ? `<div class="generation-error" role="alert"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><span>${escapeHtml(this._generationError)}</span></div>` : ""}
          <button class="primary-action" id="generate" ${canGenerate ? "" : "disabled"} type="button">
            <ha-icon icon="${this._generating ? "mdi:loading" : "mdi:creation-outline"}" class="${this._generating ? "spin" : ""}"></ha-icon>
            ${this._generating ? "Designing card" : hasResult ? "Generate another" : "Generate card"}
          </button>
          ${this._selectedEntityCount() ? "" : '<p class="warning">Select at least one entity before generating.</p>'}
          <p class="model-caption">${escapeHtml(this._settings.ai_enabled ? this._settings.model : "Configure the OpenAI API key in integration options")}</p>
        </aside>

        <section class="workspace">
          <header class="workspace-header">
            <div>
              <span>03 · Live preview</span>
              <h2>${escapeHtml(this._result?.card_config?.card?.intent?.title || "Your card will appear here")}</h2>
              <p>${escapeHtml(this._result?.summary || "Preview uses your current Home Assistant state and real card controls.")}</p>
            </div>
            <div class="toolbar">
              <div class="preview-sizes" aria-label="Preview width">
                ${[
                  ["narrow", "mdi:cellphone", "Narrow"],
                  ["medium", "mdi:tablet", "Medium"],
                  ["wide", "mdi:monitor", "Wide"],
                ].map(([size, icon, label]) => `<button class="${this._previewSize === size ? "active" : ""}" data-preview-size="${size}" title="${label} preview" type="button"><ha-icon icon="${icon}"></ha-icon></button>`).join("")}
              </div>
              <span class="live-indicator"><i></i>Live controls</span>
            </div>
          </header>

          <section class="preview-stage">
            <div id="previewHost" class="preview-host ${this._previewSize}">
              ${this._result?.card_config ? "" : this._emptyPreviewMarkup("Generate a card to see the real UrDash v2 renderer.")}
            </div>
          </section>

          <footer class="result-actions">
            <button class="secondary-action" id="toggleConfig" ${hasResult ? "" : "disabled"} type="button"><ha-icon icon="mdi:code-json"></ha-icon>Configuration</button>
            <button class="secondary-action" id="copyYaml" ${this._result?.yaml ? "" : "disabled"} type="button"><ha-icon icon="mdi:content-copy"></ha-icon>Copy YAML</button>
            <button class="install-action" id="openInstall" ${this._result?.candidate_id ? "" : "disabled"} type="button"><ha-icon icon="mdi:view-dashboard-plus-outline"></ha-icon>Add to dashboard</button>
          </footer>

          ${this._showConfig && hasResult ? `<section class="config-drawer">
            <div class="config-header"><h2>Generated configuration</h2><button id="copyJson" type="button">Copy JSON</button></div>
            <pre>${escapeHtml(this._result.json || this._result.yaml)}</pre>
          </section>` : ""}
        </section>
        ${this._installDialogMarkup()}
      </main>
    `;

    this.shadowRoot.querySelector("#generate").addEventListener("click", () => this._generate());
    this.shadowRoot.querySelector("#copyYaml").addEventListener("click", () => this._copyYaml());
    this.shadowRoot.querySelector("#copyJson")?.addEventListener("click", () => this._copyJson());
    this.shadowRoot.querySelector("#openInstall").addEventListener("click", () => this._openInstall());
    this.shadowRoot.querySelector("#toggleConfig").addEventListener("click", () => {
      this._captureDraft();
      this._showConfig = !this._showConfig;
      this._render();
    });
    this.shadowRoot.querySelector("#entityFilter").addEventListener("input", (event) => this._setEntityFilter(event.target.value));
    this.shadowRoot.querySelector("#areaFilter").addEventListener("change", (event) => this._setAreaFilter(event.target.value));
    this.shadowRoot.querySelector("#selectedOnly").addEventListener("change", (event) => this._setSelectedOnly(event.target.checked));
    this.shadowRoot.querySelector("#selectAllEntities").addEventListener("click", () => this._selectAllEntities());
    this.shadowRoot.querySelector("#selectNoEntities").addEventListener("click", () => this._selectNoEntities());
    this.shadowRoot.querySelector("#styleSelect").addEventListener("change", (event) => this._setStyle(event.target.value));
    this.shadowRoot.querySelector("#heightButtons").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-height-mode]");
      if (button) this._setHeightMode(button.dataset.heightMode);
    });
    this.shadowRoot.querySelector(".entity-groups").addEventListener("change", (event) => {
      const target = event.target;
      if (target.matches("input[data-entity-id]")) this._toggleEntity(target.dataset.entityId, target.checked);
      if (target.matches("input[data-group-id]")) this._toggleEntityGroup(target.dataset.groupId, target.checked);
    });
    this.shadowRoot.querySelector(".preview-sizes").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-preview-size]");
      if (button) this._setPreviewSize(button.dataset.previewSize);
    });
    this.shadowRoot.querySelectorAll("[data-close-install]").forEach((button) => {
      button.addEventListener("click", () => this._closeInstall());
    });
    this.shadowRoot.querySelector("#installDashboard")?.addEventListener("change", (event) => this._setInstallDashboard(event.target.value));
    this.shadowRoot.querySelector("#installView")?.addEventListener("change", (event) => {
      this._captureDraft();
      this._installViewId = event.target.value;
    });
    this.shadowRoot.querySelector("#confirmInstall")?.addEventListener("click", () => this._installCard());
    if (this._result?.card_config) this._mountPreview();
  }

  _entitySelectionMarkup() {
    if (!this._entities.length) return '<p class="muted">No entities found.</p>';
    const groups = this._entityGroups();
    if (!groups.length) return '<p class="muted">No entities match the current filter.</p>';
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

  _emptyPreview(text) {
    const empty = document.createElement("div");
    empty.className = "empty-preview";
    empty.textContent = text;
    return empty;
  }

  _emptyPreviewMarkup(text) {
    return `<div class="empty-preview">${escapeHtml(text)}</div>`;
  }

  _nextFrame() {
    return new Promise((resolve) => window.requestAnimationFrame(resolve));
  }

  _isValidationMode() {
    return new URLSearchParams(window.location.search).has("urdash_validation");
  }

  _renderError(error) {
    this.shadowRoot.innerHTML = `
      <style>${styles}</style>
      <main class="studio">
        <section class="load-error">
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

const VALIDATION_CARD = {
  type: "custom:urdash-card",
  urdash_schema: 2,
  height_mode: "auto",
  card: {
    intent: {
      goal: "room_control",
      title: "Living Room Command",
      summary: "A v2 validation card combining comfort, lighting, cover, and security signals.",
      risk_level: "medium",
      primary_entities: [
        "input_boolean.urdash_demo_living_room",
        "sensor.urdash_demo_temperature",
        "sensor.urdash_demo_humidity",
        "input_boolean.urdash_demo_security",
      ],
      primary_actions: ["light.toggle", "climate.set_temperature", "scene.turn_on"],
    },
    layout: {
      type: "grid",
      columns: 12,
      density: "comfortable",
      theme: "aurora",
      blocks: [
        {
          id: "headline",
          kind: "text",
          text: "Living room is ready",
          subtitle: "Comfort, lights, and home mode in one card",
          variant: "headline",
          grid: { col: 1, row: 1, w: 7, h: 2 },
          style: { emphasis: "hero", tone: "cool", accent: "#1f8a70" },
          animation: { preset: "fade_in", trigger: "on_load", speed: "normal", intensity: "subtle" },
        },
        {
          id: "comfort",
          kind: "value_cluster",
          title: "Comfort",
          grid: { col: 8, row: 1, w: 5, h: 2 },
          items: [
            { entity: "sensor.urdash_demo_temperature", label: "Temp", value: "state" },
            { entity: "sensor.urdash_demo_humidity", label: "Humidity", value: "state" },
          ],
        },
        {
          id: "quick",
          kind: "button_group",
          title: "Quick actions",
          grid: { col: 1, row: 3, w: 6, h: 2 },
          buttons: [
            {
              label: "Living details",
              icon: "mdi:sofa",
              action: { type: "more_info", entity_id: "input_boolean.urdash_demo_living_room" },
            },
            {
              label: "Security details",
              icon: "mdi:shield-home",
              action: { type: "more_info", entity_id: "input_boolean.urdash_demo_security" },
            },
          ],
        },
        {
          id: "timeline",
          kind: "timeline",
          title: "Signals",
          entities: [
            "input_boolean.urdash_demo_living_room",
            "input_boolean.urdash_demo_security",
            "sensor.urdash_demo_temperature",
          ],
          grid: { col: 7, row: 3, w: 6, h: 2 },
        },
      ],
    },
  },
};

const VALIDATION_RESULT = {
  candidate_id: "validation-candidate",
  summary: "Validation fixture loaded from the UrDash frontend. No AI request was made.",
  engine: "validation",
  schema: 2,
  card_config: VALIDATION_CARD,
  yaml: `type: custom:urdash-card
urdash_schema: 2
height_mode: auto
card:
  intent:
    goal: room_control
    title: Living Room Command
    summary: A v2 validation card combining comfort, lighting, cover, and security signals.
    risk_level: medium
    primary_entities:
      - input_boolean.urdash_demo_living_room
      - sensor.urdash_demo_temperature
      - sensor.urdash_demo_humidity
      - input_boolean.urdash_demo_security
    primary_actions:
      - light.toggle
      - climate.set_temperature
      - scene.turn_on
  layout:
    type: grid
    columns: 12
    density: comfortable
    theme: aurora
    blocks: []`,
  json: JSON.stringify(VALIDATION_CARD, null, 2),
};

const styles = `
  :host {
    display: block;
    min-height: 100vh;
    color: #172326;
    font-family: var(--paper-font-body1_-_font-family, Inter, ui-sans-serif, system-ui, sans-serif);
  }

  * { box-sizing: border-box; }
  button, input, textarea { font: inherit; }
  h1, h2, p { margin: 0; }

  .studio {
    min-height: 100vh;
    display: grid;
    grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
    gap: 18px;
    padding: 20px;
    background: #edf2f1;
  }

  .composer, .workspace, .preview-card, .output-panel, .system-card, .entity-panel, .load-error {
    border: 1px solid rgba(92,112,116,0.2);
    border-radius: 8px;
    background: rgba(255,255,255,0.82);
    box-shadow: 0 18px 42px rgba(36,54,58,0.1);
  }

  .composer {
    display: grid;
    align-content: start;
    gap: 16px;
    padding: 18px;
  }

  .brand, .panel-title, .workspace-header, .toolbar {
    display: flex;
    align-items: center;
  }

  .brand {
    gap: 12px;
  }

  .brand-mark {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: 8px;
    background: #143d3a;
    color: #fff;
    font-size: 14px;
    font-weight: 900;
  }

  h1 { font-size: 24px; }
  h2 { color: #182d31; font-size: 16px; }
  .brand p, .workspace-header p, .muted, .ai-status span, .field > span, .panel-title span {
    color: #617174;
    font-size: 13px;
  }

  .field {
    display: grid;
    gap: 8px;
  }

  .field > span, .panel-title span {
    font-weight: 800;
  }

  textarea, input[type="search"] {
    width: 100%;
    border: 1px solid #cbd8d8;
    border-radius: 8px;
    padding: 12px;
    color: #182d31;
    background: #fff;
    line-height: 1.45;
  }

  textarea { resize: vertical; }
  input[type="checkbox"] { accent-color: #143d3a; }

  .choice-grid {
    display: grid;
    gap: 12px;
  }

  .segmented {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 4px;
    padding: 4px;
    border: 1px solid #d3ddde;
    border-radius: 8px;
    background: #f6f8f8;
  }

  .segmented.three {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .segmented button, .primary-action, .toolbar button, .entity-actions button {
    border: 0;
    cursor: pointer;
  }

  .segmented button {
    min-height: 34px;
    border-radius: 6px;
    background: transparent;
    color: #3d5054;
    font-size: 12px;
    font-weight: 800;
  }

  .segmented button.active {
    background: #fff;
    color: #103c38;
    box-shadow: 0 1px 4px rgba(27,50,55,0.16);
  }

  .entity-panel, .system-card {
    display: grid;
    gap: 12px;
    padding: 14px;
    box-shadow: none;
  }

  .panel-title {
    justify-content: space-between;
    gap: 12px;
  }

  .panel-title strong {
    color: #31565c;
    font-size: 12px;
  }

  .entity-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
  }

  .entity-actions > div, .toolbar {
    display: flex;
    gap: 8px;
  }

  .entity-actions button, .toolbar button {
    min-height: 36px;
    border-radius: 8px;
    padding: 0 12px;
    background: #e6eeee;
    color: #193a3d;
    font-weight: 850;
  }

  .entity-groups {
    max-height: 360px;
    display: grid;
    gap: 8px;
    overflow: auto;
  }

  .entity-group {
    border: 1px solid #d9e2e3;
    border-radius: 8px;
    background: #fff;
  }

  .entity-group summary {
    cursor: pointer;
    list-style: none;
    padding: 9px 10px;
  }

  .entity-group summary::-webkit-details-marker { display: none; }
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

  .primary-action {
    min-height: 46px;
    display: inline-flex;
    gap: 9px;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    background: #103c38;
    color: #fff;
    font-weight: 900;
  }

  .primary-action span, .spin {
    width: 9px;
    height: 9px;
    border-radius: 999px;
    background: currentColor;
  }

  .spin {
    animation: pulse 0.8s infinite alternate;
  }

  .primary-action:disabled, .toolbar button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .warning, .error-text {
    color: #9a5b13;
    font-size: 13px;
  }

  .error-text { color: #9b2f2f; }

  .ai-status {
    display: grid;
    gap: 3px;
  }

  .ai-status strong {
    color: #18383a;
    font-size: 13px;
  }

  .domain-list {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
  }

  .domain-list span {
    padding: 5px 8px;
    border-radius: 6px;
    background: #e7eeee;
    color: #385054;
    font-size: 12px;
  }

  .workspace {
    min-width: 0;
    display: grid;
    align-content: start;
    gap: 16px;
    padding: 18px;
  }

  .workspace-header {
    justify-content: space-between;
    gap: 14px;
  }

  .workspace-header span {
    color: #1f7167;
    font-size: 12px;
    font-weight: 900;
    text-transform: uppercase;
  }

  .workspace-header h2 {
    margin-top: 4px;
    font-size: 26px;
  }

  .preview-card {
    min-height: 320px;
    padding: 14px;
    background: #f8fbfa;
    box-shadow: none;
  }

  .preview-host {
    display: block;
  }

  .empty-preview {
    min-height: 280px;
    display: grid;
    place-items: center;
    border: 1px dashed #b9c8ca;
    border-radius: 8px;
    color: #607174;
    text-align: center;
  }

  .output-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }

  .output-panel {
    min-width: 0;
    display: grid;
    gap: 10px;
    padding: 14px;
    box-shadow: none;
  }

  pre {
    max-height: 420px;
    margin: 0;
    overflow: auto;
    border-radius: 8px;
    padding: 12px;
    background: #142225;
    color: #e8f4ef;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .load-error {
    grid-column: 1 / -1;
    max-width: 720px;
    margin: 40px auto;
    padding: 24px;
  }

  @keyframes pulse {
    from { opacity: 0.35; transform: scale(0.75); }
    to { opacity: 1; transform: scale(1); }
  }

  /* Generation console */
  :host {
    --console-ink: #17272a;
    --console-muted: #657477;
    --console-line: #d7e0df;
    --console-surface: #ffffff;
    --console-soft: #f2f6f5;
    --console-accent: #176b61;
    --console-warm: #df6f45;
  }

  .studio {
    grid-template-columns: minmax(350px, 410px) minmax(0, 1fr);
    gap: 0;
    padding: 0;
    background: #e9efed;
  }

  .composer, .workspace {
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }

  .composer {
    max-height: 100vh;
    gap: 0;
    overflow-y: auto;
    padding: 0;
    background: var(--console-surface);
    border-right: 1px solid var(--console-line);
  }

  .brand {
    position: sticky;
    top: 0;
    z-index: 3;
    min-height: 72px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--console-line);
    background: rgba(255,255,255,0.96);
    backdrop-filter: blur(14px);
  }

  .brand-mark { background: #173b39; }
  .brand-mark ha-icon { --mdc-icon-size: 21px; }
  .brand h1 { font-size: 18px; letter-spacing: 0; }

  .ready-state {
    margin-left: auto;
    color: #9b3d32;
    font-size: 11px;
    font-weight: 800;
  }

  .ready-state::before {
    content: "";
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: 6px;
    border-radius: 50%;
    background: currentColor;
  }

  .ready-state.ready { color: #16806c; }

  .composer-section {
    display: grid;
    gap: 12px;
    padding: 18px;
    border-bottom: 1px solid var(--console-line);
  }

  .composer-section .panel-title span { color: var(--console-warm); }
  .composer-section .panel-title h2 { margin-top: 2px; font-size: 15px; }

  select {
    width: 100%;
    min-height: 42px;
    border: 1px solid #c8d4d3;
    border-radius: 7px;
    padding: 0 36px 0 11px;
    color: var(--console-ink);
    background: #fff;
    font: inherit;
  }

  textarea:focus, input:focus, select:focus, button:focus-visible {
    outline: 3px solid rgba(23,107,97,0.2);
    outline-offset: 1px;
    border-color: var(--console-accent);
  }

  .search-control {
    min-width: 0;
    display: flex;
    align-items: center;
    border: 1px solid #c8d4d3;
    border-radius: 7px;
    padding-left: 10px;
    background: #fff;
  }

  .search-control ha-icon { --mdc-icon-size: 18px; color: var(--console-muted); }
  .search-control input { min-width: 0; border: 0; padding: 10px 8px; background: transparent; }
  .search-control input:focus { outline: 0; }

  .entity-filters {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: end;
  }

  .entity-filters > label:first-child { display: grid; gap: 5px; }
  .entity-filters label > span { color: var(--console-muted); font-size: 11px; font-weight: 800; }
  .entity-filters select { min-height: 38px; }

  .selected-toggle {
    min-height: 38px;
    display: flex;
    gap: 7px;
    align-items: center;
    padding: 0 9px;
    border: 1px solid var(--console-line);
    border-radius: 7px;
    background: var(--console-soft);
  }

  .entity-groups { max-height: 310px; padding-right: 3px; }
  .entity-panel, .system-card { border: 0; }

  .style-summary {
    display: grid;
    grid-template-columns: 50px minmax(0, 1fr);
    gap: 11px;
    align-items: center;
    min-height: 58px;
    padding: 8px;
    border: 1px solid var(--console-line);
    border-radius: 7px;
    background: var(--console-soft);
  }

  .style-summary p { color: #526366; font-size: 12px; line-height: 1.4; }
  .style-swatch { height: 40px; border-radius: 5px; background: linear-gradient(145deg, #173b39, #d8ebe4 65%, #df6f45); }
  .style-summary[data-style="minimal"] .style-swatch { background: linear-gradient(145deg, #fafafa 0 48%, #1c292b 49% 54%, #dfe5e4 55%); }
  .style-summary[data-style="glassmorphism"] .style-swatch { background: linear-gradient(145deg, #63b9b0, #d7d2f2 50%, #f4ae8c); }
  .style-summary[data-style="bento"] .style-swatch { background: conic-gradient(from 90deg, #dce9e6, #176b61, #f1b867, #dce9e6); }
  .style-summary[data-style="editorial"] .style-swatch { background: linear-gradient(90deg, #f4efe6 0 58%, #1d292b 58% 69%, #b64736 69%); }
  .style-summary[data-style="material"] .style-swatch { background: linear-gradient(145deg, #1976d2, #e3f2fd 52%, #ffb300); }
  .style-summary[data-style="neobrutalist"] .style-swatch { background: linear-gradient(145deg, #f7df47 0 45%, #111 46% 53%, #f07167 54%); }
  .style-summary[data-style="futuristic"] .style-swatch { background: radial-gradient(circle, #55e9d0, #15373e 45%, #071315 70%); }
  .style-summary[data-style="organic"] .style-swatch { background: radial-gradient(circle at 30% 30%, #eef0d6, #7ca982 45%, #28433c); }
  .style-summary[data-style="monochrome"] .style-swatch { background: linear-gradient(145deg, #fff, #777 50%, #111); }
  .style-summary[data-style="luxury"] .style-swatch { background: linear-gradient(145deg, #111818, #bf9b58 50%, #f3e7ca); }
  .style-summary[data-style="playful"] .style-swatch { background: conic-gradient(#ef6f6c, #ffd166, #4ecdc4, #6c63ff, #ef6f6c); }

  .field > span em {
    margin-left: 6px;
    color: #879395;
    font-size: 10px;
    font-style: normal;
    font-weight: 700;
  }

  .prompt-field textarea { min-height: 130px; }

  .advanced-options {
    border-top: 1px solid var(--console-line);
    padding-top: 10px;
  }

  .advanced-options summary { cursor: pointer; color: #526366; font-size: 12px; font-weight: 800; }
  .advanced-options .field { margin-top: 10px; }

  .primary-action {
    min-height: 48px;
    margin: 16px 18px 5px;
    background: var(--console-accent);
  }

  .primary-action ha-icon { --mdc-icon-size: 19px; }
  .primary-action .spin { width: auto; height: auto; animation: rotate 1s linear infinite; background: transparent; }
  .model-caption { padding: 0 18px 18px; color: #7c898b; font-size: 11px; text-align: center; }
  .warning { padding: 3px 18px 0; }

  .generation-error {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 8px;
    margin: 14px 18px 0;
    border-left: 3px solid #b84c3f;
    padding: 10px;
    background: #fff2ef;
    color: #87382e;
    font-size: 12px;
  }

  .generation-error ha-icon { --mdc-icon-size: 18px; }

  .workspace {
    min-height: 100vh;
    padding: 22px clamp(16px, 3vw, 42px) 28px;
    background: #e9efed;
  }

  .workspace-header { min-height: 66px; }
  .workspace-header h2 { font-size: 22px; letter-spacing: 0; }
  .workspace-header p { max-width: 640px; margin-top: 4px; }

  .toolbar { flex-wrap: wrap; justify-content: flex-end; }
  .preview-sizes { display: flex; gap: 3px; padding: 3px; border: 1px solid #cbd6d5; border-radius: 7px; background: #f7f9f8; }
  .preview-sizes button { width: 36px; height: 34px; display: grid; place-items: center; border: 0; border-radius: 5px; background: transparent; color: #5f6e71; cursor: pointer; }
  .preview-sizes button.active { background: #fff; color: var(--console-accent); box-shadow: 0 1px 4px rgba(24,48,48,0.18); }
  .preview-sizes ha-icon { --mdc-icon-size: 18px; }

  .live-indicator { color: #506265; font-size: 11px; font-weight: 800; white-space: nowrap; }
  .live-indicator i { display: inline-block; width: 7px; height: 7px; margin-right: 5px; border-radius: 50%; background: #1a9b76; box-shadow: 0 0 0 3px rgba(26,155,118,0.12); }

  .preview-stage {
    min-height: 540px;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    overflow: auto;
    padding: clamp(16px, 3vw, 42px);
    border: 1px solid #d1dbda;
    border-radius: 8px;
    background-color: #f7f9f8;
    background-image: linear-gradient(#e7eceb 1px, transparent 1px), linear-gradient(90deg, #e7eceb 1px, transparent 1px);
    background-size: 24px 24px;
  }

  .preview-host { width: 100%; transition: width 180ms ease; }
  .preview-host.narrow { width: min(100%, 390px); }
  .preview-host.medium { width: min(100%, 680px); }
  .preview-host.wide { width: min(100%, 1040px); }
  .empty-preview { min-height: 460px; border-color: #b4c3c1; background: rgba(255,255,255,0.72); }

  .result-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .result-actions button, .config-header button {
    min-height: 42px;
    display: inline-flex;
    gap: 7px;
    align-items: center;
    justify-content: center;
    border: 1px solid #c8d4d3;
    border-radius: 7px;
    padding: 0 13px;
    background: #fff;
    color: #2e494c;
    font-weight: 800;
    cursor: pointer;
  }

  .result-actions ha-icon { --mdc-icon-size: 18px; }
  .result-actions .install-action { border-color: #173b39; background: #173b39; color: #fff; }
  .result-actions button:disabled { cursor: not-allowed; opacity: 0.45; }

  .config-drawer { display: grid; gap: 10px; border-top: 1px solid #ccd7d5; padding-top: 16px; }
  .config-header { display: flex; justify-content: space-between; align-items: center; }
  .config-header h2 { font-size: 15px; }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: grid;
    place-items: center;
    padding: 18px;
    background: rgba(18,31,33,0.52);
    backdrop-filter: blur(5px);
  }

  .install-dialog {
    width: min(100%, 480px);
    display: grid;
    gap: 18px;
    border: 1px solid rgba(255,255,255,0.5);
    border-radius: 8px;
    padding: 20px;
    background: #fff;
    box-shadow: 0 28px 80px rgba(14,34,36,0.32);
  }

  .dialog-header, .config-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .dialog-header span { color: var(--console-warm); font-size: 11px; font-weight: 900; text-transform: uppercase; }
  .dialog-header h2 { margin-top: 3px; font-size: 20px; }
  .icon-action { width: 40px; height: 40px; display: grid; place-items: center; border: 0; border-radius: 7px; background: var(--console-soft); color: var(--console-ink); cursor: pointer; }

  .install-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }

  .placement-summary {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 10px;
    align-items: start;
    border-left: 3px solid var(--console-accent);
    padding: 11px 12px;
    background: #eef7f4;
    color: #40595b;
    font-size: 12px;
    line-height: 1.45;
  }

  .placement-summary ha-icon { --mdc-icon-size: 19px; color: var(--console-accent); }
  .install-error { margin: 0; }
  .target-loading { min-height: 120px; display: flex; gap: 10px; align-items: center; justify-content: center; color: var(--console-muted); font-size: 13px; font-weight: 800; }
  .spin-dot { width: 14px; height: 14px; border: 2px solid #bad0cc; border-top-color: var(--console-accent); border-radius: 50%; animation: rotate 0.8s linear infinite; }

  .dialog-actions { display: flex; gap: 9px; justify-content: flex-end; }
  .dialog-actions button, .dialog-actions a {
    min-height: 42px;
    display: inline-flex;
    gap: 7px;
    align-items: center;
    justify-content: center;
    border-radius: 7px;
    padding: 0 15px;
    font: inherit;
    font-weight: 850;
    text-decoration: none;
    cursor: pointer;
  }

  .dialog-actions .secondary-action { border: 1px solid #c8d4d3; background: #fff; color: #405558; }
  .install-confirm { border: 1px solid #173b39; background: #173b39; color: #fff; }
  .install-confirm:disabled { cursor: not-allowed; opacity: 0.5; }
  .install-confirm ha-icon { --mdc-icon-size: 18px; }

  .success-mark { width: 56px; height: 56px; display: grid; place-items: center; margin: 4px auto 0; border-radius: 50%; background: #dff4ed; color: #11745f; }
  .success-mark ha-icon { --mdc-icon-size: 28px; }
  .install-success { display: grid; gap: 6px; text-align: center; }
  .install-success h2 { font-size: 22px; }
  .install-success p { color: var(--console-muted); font-size: 13px; line-height: 1.5; }

  @keyframes rotate { to { transform: rotate(360deg); } }

  @media (max-width: 980px) {
    .studio {
      grid-template-columns: 1fr;
      padding: 0;
    }

    .composer { max-height: none; border-right: 0; border-bottom: 1px solid var(--console-line); }
    .workspace { min-height: auto; }
    .preview-stage { min-height: 420px; padding: 14px; }
    .empty-preview { min-height: 350px; }

    .output-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 560px) {
    .brand { min-height: 64px; padding: 10px 12px; }
    .brand-mark { width: 38px; height: 38px; }
    .brand p { display: none; }
    .composer-section { padding: 15px 12px; }
    .entity-actions, .entity-filters { grid-template-columns: 1fr; }
    .entity-actions > div { justify-content: flex-end; }
    .selected-toggle { justify-content: center; }
    .primary-action { margin-inline: 12px; }
    .model-caption { padding-inline: 12px; }
    .workspace { padding: 14px 10px 20px; }
    .workspace-header { align-items: flex-start; flex-direction: column; }
    .toolbar { width: 100%; justify-content: space-between; }
    .preview-stage { min-height: 360px; padding: 8px; }
    .empty-preview { min-height: 300px; padding: 18px; }
    .result-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .result-actions .install-action { grid-column: 1 / -1; }
    .install-fields { grid-template-columns: 1fr; }
    .install-dialog { padding: 17px; }
    .dialog-actions { display: grid; grid-template-columns: 1fr 1fr; }
  }
`;

customElements.define("urdash-panel", UrDashPanel);
