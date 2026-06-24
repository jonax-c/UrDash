class UrDashPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._entities = [];
    this._resources = [];
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
    this._appendResult = null;
    this._previewResult = null;
    this._loaded = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._loaded) {
      this._loaded = true;
      this._load();
    }
  }

  async _load() {
    this._render();
    try {
      const [entityPayload, resourcePayload, settingsPayload] = await Promise.all([
        this._hass.connection.sendMessagePromise({ type: "urdash/entities" }),
        this._hass.connection.sendMessagePromise({ type: "urdash/resources" }),
        this._hass.connection.sendMessagePromise({ type: "urdash/settings" }),
      ]);
      this._entities = entityPayload.entities || [];
      this._resources = resourcePayload.resources || [];
      this._settings = { ...this._settings, ...settingsPayload };
      this._style = this._settings.default_style || this._style;
      this._allowCustomCards = Boolean(this._settings.allow_custom_cards);
      this._render();
    } catch (error) {
      this._renderError(error);
    }
  }

  async _generate() {
    const requestInput = this.shadowRoot.querySelector("#request");
    const referenceInput = this.shadowRoot.querySelector("#referenceDashboard");
    const request = requestInput.value.trim();
    if (!request) return;

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
        reference_dashboard: parseReferenceDashboard(referenceInput.value),
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
    if (!this._result?.yaml) return;
    await navigator.clipboard.writeText(this._result.yaml);
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
    if (!this._result?.view) return;

    const button = this.shadowRoot.querySelector("#writePreview");
    button.disabled = true;
    button.textContent = "Preparing";

    try {
      this._previewResult = await this._hass.connection.sendMessagePromise({
        type: "urdash/preview_view",
        view: this._result.view,
      });
      this._render();
      if (this._previewResult?.ok && this._previewResult.path) {
        window.open(this._previewResult.path, "_blank", "noopener");
      }
    } catch (error) {
      this._previewResult = { ok: false, error: error?.message || String(error) };
      this._render();
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

  _domainStats() {
    const counts = new Map();
    for (const entity of this._entities) {
      const domain = entity.entity_id?.split(".")[0];
      if (domain) counts.set(domain, (counts.get(domain) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
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
              <div class="segmented two" id="modeButtons">
                <button class="${this._mode === "new_view" ? "active" : ""}" data-mode="new_view" type="button">new tab</button>
                <button class="${this._mode === "dashboard" ? "active" : ""}" data-mode="dashboard" type="button">full dashboard</button>
              </div>
            </div>

            <label class="field ${this._mode === "new_view" ? "" : "hidden"}">
              <span>Reference dashboard YAML or JSON</span>
              <textarea id="referenceDashboard" rows="6" placeholder="Paste current dashboard YAML here. UrDash uses it only as reference and generates a new tab.">${escapeHtml(this._currentReference())}</textarea>
            </label>

            <label class="toggle-row">
              <input id="allowCustomCards" ${this._allowCustomCards ? "checked" : ""} type="checkbox" />
              <span>Use premium custom cards</span>
            </label>

            <button class="primary-action" id="generate" type="button">
              <span>*</span>
              Generate dashboard
            </button>

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
              </div>
              <div class="toolbar-actions">
                <button class="icon-button" id="writePreview" ${this._result?.view ? "" : "disabled"} title="Preview in real Lovelace" type="button">Preview</button>
                <button class="icon-button" id="appendView" ${this._result?.view ? "" : "disabled"} title="Add as new Lovelace tab" type="button">Add tab</button>
                <button class="icon-button" id="copyYaml" ${this._result?.yaml ? "" : "disabled"} title="Copy YAML" type="button">Copy</button>
              </div>
            </div>

            ${this._previewResult ? `
              <div class="${this._previewResult.ok ? "status-box success" : "status-box error"}">
                ${this._previewResult.ok
                  ? `Preview dashboard updated. <a href="${escapeHtml(this._previewResult.path)}" target="_blank" rel="noopener">Open real Lovelace preview</a>.`
                  : escapeHtml(this._previewResult.error || "Could not prepare the preview dashboard.")}
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
              <h3>Real Lovelace Preview</h3>
              <p>Use Preview to render the generated tab in Home Assistant's actual Lovelace renderer. The old simulated preview has been removed because it does not reflect real cards or layout.</p>
              ${this._previewResult?.ok ? `<iframe title="UrDash Lovelace preview" src="${escapeHtml(this._previewResult.path)}"></iframe>` : ""}
            </section>

            <section class="yaml-panel">
              <div class="section-title">
                <span>YAML</span>
                <h3>Lovelace YAML</h3>
              </div>
              <pre>${escapeHtml(this._result?.yaml || "Generate a dashboard to see YAML output.")}</pre>
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
    this.shadowRoot.querySelector("#styleButtons").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-style]");
      if (button) this._setStyle(button.dataset.style);
    });
    this.shadowRoot.querySelector("#modeButtons").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-mode]");
      if (button) this._setMode(button.dataset.mode);
    });
  }

  _currentRequest() {
    const existing = this.shadowRoot.querySelector("#request")?.value;
    return existing || "Create a beautiful family dashboard with quick controls for lights, climate, doors, energy, and room-by-room status.";
  }

  _currentReference() {
    return this.shadowRoot.querySelector("#referenceDashboard")?.value || "";
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
        </div>
      </div>
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

function parseReferenceDashboard(value) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    return { raw_yaml: trimmed };
  }
}

const styles = `
  :host {
    display: block;
    min-height: 100vh;
    color: #152126;
    font-family: var(--paper-font-body1_-_font-family, Inter, ui-sans-serif, system-ui, sans-serif);
  }

  * { box-sizing: border-box; }
  button, textarea { font: inherit; }
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

  textarea {
    width: 100%;
    resize: vertical;
    border: 1px solid #cad5d6;
    border-radius: 8px;
    padding: 12px;
    color: #1d2f33;
    background: #ffffff;
    line-height: 1.45;
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

  .stats-panel, .dependency-panel, .yaml-panel {
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
  .section-title h3 { font-size: 15px; }
  .dependency-row { gap: 10px; margin-top: 10px; }
  .dependency-row strong { font-size: 13px; }

  .dependency-row em {
    color: #5d6f72;
    font-size: 11px;
    font-style: normal;
    font-weight: 700;
    margin-left: 4px;
    text-transform: uppercase;
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

  .real-preview-panel iframe {
    width: 100%;
    min-height: 680px;
    border: 1px solid #cad5d6;
    border-radius: 8px;
    background: #ffffff;
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
