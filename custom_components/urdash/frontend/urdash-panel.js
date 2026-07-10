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
    };
    this._theme = "aurora";
    this._heightMode = "auto";
    this._result = null;
    this._selectedEntityIds = new Set();
    this._entityFilter = "";
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
      const [entityPayload, settingsPayload] = await Promise.all([
        this._hass.connection.sendMessagePromise({ type: "urdash/entities" }),
        this._hass.connection.sendMessagePromise({ type: "urdash/settings" }),
      ]);
      this._entities = entityPayload.entities || [];
      this._selectedEntityIds = new Set(this._entities.map((entity) => entity.entity_id).filter(Boolean));
      this._settings = { ...this._settings, ...settingsPayload };
      this._theme = this._settings.default_theme || this._theme;
      this._heightMode = this._settings.default_height_mode || this._heightMode;
      if (this._isValidationMode()) this._result = VALIDATION_RESULT;
      this._render();
      if (this._result?.card_config) await this._mountPreview();
    } catch (error) {
      this._renderError(error);
    }
  }

  async _generate() {
    const request = this.shadowRoot.querySelector("#request")?.value.trim();
    if (!request || !this._selectedEntityCount()) return;

    const button = this.shadowRoot.querySelector("#generate");
    button.disabled = true;
    button.innerHTML = '<span class="spin"></span> Generating';

    try {
      this._result = await this._hass.connection.sendMessagePromise({
        type: "urdash/generate",
        request,
        theme: this._theme,
        height_mode: this._heightMode,
        selected_entity_ids: this._selectedEntityIdsList(),
      });
      this._render();
      if (this._result?.card_config) {
        await this._nextFrame();
        await this._mountPreview();
      }
    } catch (error) {
      this._renderError(error);
    } finally {
      const currentButton = this.shadowRoot.querySelector("#generate");
      if (currentButton) {
        currentButton.disabled = false;
        currentButton.innerHTML = "<span></span> Generate v2 card";
      }
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
    const host = this.shadowRoot.querySelector("#previewHost");
    if (!host) return;
    host.innerHTML = "";
    if (!this._result?.card_config) {
      host.appendChild(this._emptyPreview("Generate a card to see the real UrDash renderer."));
      return;
    }
    await this._loadUrDashCard();
    const card = document.createElement("urdash-card");
    card.setConfig({ ...this._result.card_config, preview: true });
    card.hass = this._hass;
    host.appendChild(card);
  }

  async _loadUrDashCard() {
    if (customElements.get("urdash-card")) return;
    await import("/urdash/static/urdash-custom-card.js?v=20260710.5");
  }

  _refreshPreviewHass() {
    const card = this.shadowRoot.querySelector("urdash-card");
    if (card) card.hass = this._hass;
  }

  _setTheme(theme) {
    this._theme = theme;
    this._render();
  }

  _setHeightMode(heightMode) {
    this._heightMode = heightMode;
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
    const group = this._entityGroups().find((item) => item.id === groupId);
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

  _entityGroups() {
    const filter = this._entityFilter.trim().toLowerCase();
    const groups = new Map();
    for (const entity of this._entities) {
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

  _refreshEntitySelectionMarkup() {
    const groups = this.shadowRoot.querySelector(".entity-groups");
    if (groups) groups.innerHTML = this._entitySelectionMarkup();
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>${styles}</style>
      <main class="studio">
        <aside class="composer">
          <header class="brand">
            <div class="brand-mark">U2</div>
            <div>
              <h1>UrDash v2</h1>
              <p>AI card composer</p>
            </div>
          </header>

          <label class="field">
            <span>Card request</span>
            <textarea id="request" rows="7">${escapeHtml(this._currentRequest())}</textarea>
          </label>

          <section class="choice-grid">
            <div class="field">
              <span>Theme</span>
              <div class="segmented" id="themeButtons">
                ${["aurora", "quiet", "graphite", "calm", "sunrise"].map((theme) => `
                  <button class="${this._theme === theme ? "active" : ""}" data-theme="${theme}" type="button">${theme}</button>
                `).join("")}
              </div>
            </div>
            <div class="field">
              <span>Height</span>
              <div class="segmented three" id="heightButtons">
                ${["auto", "viewport", "fixed"].map((mode) => `
                  <button class="${this._heightMode === mode ? "active" : ""}" data-height-mode="${mode}" type="button">${mode}</button>
                `).join("")}
              </div>
            </div>
          </section>

          <section class="entity-panel">
            <div class="panel-title">
              <div>
                <span>Entities</span>
                <h2>Generation context</h2>
              </div>
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
            <span></span>
            Generate v2 card
          </button>
          ${this._selectedEntityCount() ? "" : '<p class="warning">Select at least one entity before generating.</p>'}

          <section class="system-card">
            <div class="ai-status">
              <strong>${this._settings.ai_enabled ? "AI ready" : "API key required"}</strong>
              <span>${escapeHtml(this._settings.ai_enabled ? this._settings.model : "Add an OpenAI API key in integration options")}</span>
            </div>
            <div class="domain-list">
              ${this._domainStats().map(([domain, count]) => `<span>${escapeHtml(domain)} ${count}</span>`).join("")}
            </div>
          </section>
        </aside>

        <section class="workspace">
          <header class="workspace-header">
            <div>
              <span>Schema v2</span>
              <h2>${escapeHtml(this._result?.card_config?.card?.intent?.title || "Card preview")}</h2>
              <p>${escapeHtml(this._result?.summary || "Generate a v2 UrDash card from selected Home Assistant entities.")}</p>
              ${this._result?.error ? `<p class="error-text">${escapeHtml(this._result.error)}</p>` : ""}
            </div>
            <div class="toolbar">
              <button id="copyYaml" ${this._result?.yaml ? "" : "disabled"} type="button">Copy YAML</button>
              <button id="copyJson" ${this._result?.json ? "" : "disabled"} type="button">Copy JSON</button>
            </div>
          </header>

          <section class="preview-card">
            <div id="previewHost" class="preview-host">
              ${this._result?.card_config ? "" : this._emptyPreviewMarkup("Generate a card to see the real UrDash v2 renderer.")}
            </div>
          </section>

          <section class="output-grid">
            <article class="output-panel">
              <div class="panel-title">
                <div>
                  <span>Lovelace</span>
                  <h2>YAML</h2>
                </div>
              </div>
              <pre>${escapeHtml(this._result?.yaml || "type: custom:urdash-card\nurdash_schema: 2\nheight_mode: auto\ncard:\n  intent:\n    ...")}</pre>
            </article>
            <article class="output-panel">
              <div class="panel-title">
                <div>
                  <span>Raw</span>
                  <h2>JSON</h2>
                </div>
              </div>
              <pre>${escapeHtml(this._result?.json || "{\n  \"urdash_schema\": 2\n}")}</pre>
            </article>
          </section>
        </section>
      </main>
    `;

    this.shadowRoot.querySelector("#generate").addEventListener("click", () => this._generate());
    this.shadowRoot.querySelector("#copyYaml").addEventListener("click", () => this._copyYaml());
    this.shadowRoot.querySelector("#copyJson").addEventListener("click", () => this._copyJson());
    this.shadowRoot.querySelector("#entityFilter").addEventListener("input", (event) => this._setEntityFilter(event.target.value));
    this.shadowRoot.querySelector("#selectAllEntities").addEventListener("click", () => this._selectAllEntities());
    this.shadowRoot.querySelector("#selectNoEntities").addEventListener("click", () => this._selectNoEntities());
    this.shadowRoot.querySelector("#themeButtons").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-theme]");
      if (button) this._setTheme(button.dataset.theme);
    });
    this.shadowRoot.querySelector("#heightButtons").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-height-mode]");
      if (button) this._setHeightMode(button.dataset.heightMode);
    });
    this.shadowRoot.querySelector(".entity-groups").addEventListener("change", (event) => {
      const target = event.target;
      if (target.matches("input[data-entity-id]")) this._toggleEntity(target.dataset.entityId, target.checked);
      if (target.matches("input[data-group-id]")) this._toggleEntityGroup(target.dataset.groupId, target.checked);
    });
    if (this._result?.card_config) this._mountPreview();
  }

  _currentRequest() {
    const existing = this.shadowRoot.querySelector("#request")?.value;
    return existing || "Create a beautiful and useful room control card that combines lights, climate, covers, and key sensors.";
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

  @media (max-width: 980px) {
    .studio {
      grid-template-columns: 1fr;
      padding: 12px;
    }

    .output-grid {
      grid-template-columns: 1fr;
    }
  }
`;

customElements.define("urdash-panel", UrDashPanel);
