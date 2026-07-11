const [ACTION_MANIFEST, CARD_SCHEMA] = await Promise.all([
  loadModuleJson("./action-manifest.json", "action manifest"),
  loadModuleJson("./card-schema-v2.json", "card schema"),
]);

const FORECAST_FIELDS = new Set([
  "datetime", "is_daytime", "condition", "temperature", "templow",
  "apparent_temperature", "dew_point", "precipitation",
  "precipitation_probability", "humidity", "pressure", "cloud_coverage",
  "uv_index", "wind_bearing", "wind_speed", "wind_gust_speed",
]);

async function loadModuleJson(relativePath, label) {
  const moduleUrl = new URL(import.meta.url);
  const resourceUrl = new URL(relativePath, moduleUrl);
  resourceUrl.search = moduleUrl.search;
  const response = await fetch(resourceUrl, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`UrDash ${label} failed to load (${response.status}).`);
  return response.json();
}

function validateSchema(value, schema, path = "$", diagnostics = [], rootSchema = CARD_SCHEMA) {
  if (diagnostics.length >= 64) return diagnostics;
  if (schema.$ref) {
    const resolved = resolveLocalSchemaRef(rootSchema, schema.$ref);
    if (!resolved) diagnostics.push(schemaDiagnostic(path, "schema.invalid_ref", "Schema reference could not be resolved."));
    else validateSchema(value, resolved, path, diagnostics, rootSchema);
    return diagnostics;
  }
  if (schema.anyOf) {
    const matches = schema.anyOf.some((option) => validateSchema(value, option, path, [], rootSchema).length === 0);
    if (!matches) diagnostics.push(schemaDiagnostic(path, "schema.any_of", "Value does not match any allowed schema variant."));
    return diagnostics;
  }
  if (schema.type && !matchesSchemaType(value, schema.type)) {
    diagnostics.push(schemaDiagnostic(path, "schema.type", `Expected ${schema.type}.`));
    return diagnostics;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    diagnostics.push(schemaDiagnostic(path, "schema.enum", `Value ${JSON.stringify(value)} is not allowed.`));
    return diagnostics;
  }
  if (schema.type === "object") {
    const properties = schema.properties || {};
    for (const name of schema.required || []) {
      if (!(name in value)) diagnostics.push(schemaDiagnostic(`${path}.${name}`, "schema.required", `Required key ${name} is missing.`));
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!(name in properties)) diagnostics.push(schemaDiagnostic(`${path}.${name}`, "schema.additional_property", `Unknown key ${name} is not allowed.`));
      }
    }
    for (const [name, child] of Object.entries(value)) {
      if (properties[name]) validateSchema(child, properties[name], `${path}.${name}`, diagnostics, rootSchema);
    }
  } else if (schema.type === "array") {
    if (schema.minItems != null && value.length < schema.minItems) diagnostics.push(schemaDiagnostic(path, "schema.min_items", "Array has too few items."));
    if (schema.maxItems != null && value.length > schema.maxItems) diagnostics.push(schemaDiagnostic(path, "schema.max_items", "Array exceeds its item limit."));
    value.forEach((child, index) => validateSchema(child, schema.items || {}, `${path}[${index}]`, diagnostics, rootSchema));
  } else if (["number", "integer"].includes(schema.type)) {
    if (schema.minimum != null && value < schema.minimum) diagnostics.push(schemaDiagnostic(path, "schema.minimum", `Value is below ${schema.minimum}.`));
    if (schema.maximum != null && value > schema.maximum) diagnostics.push(schemaDiagnostic(path, "schema.maximum", `Value exceeds ${schema.maximum}.`));
  }
  return diagnostics;
}

function resolveLocalSchemaRef(rootSchema, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  return ref.slice(2).split("/").reduce((current, part) => current?.[part], rootSchema) || null;
}

function matchesSchemaType(value, expected) {
  if (Array.isArray(expected)) return expected.some((item) => matchesSchemaType(value, item));
  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (expected === "array") return Array.isArray(value);
  if (expected === "integer") return Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "boolean") return typeof value === "boolean";
  if (expected === "string") return typeof value === "string";
  if (expected === "null") return value === null;
  return true;
}

function schemaDiagnostic(path, code, message) {
  return { path, code, message, severity: "error", suggestion: "Use the UrDash v2 schema contract." };
}

class UrDashCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._card = null;
    this._pendingActions = new Set();
    this._actionTimeoutMs = 15000;
    this._entityDependencies = new Set();
    this._expressionMetadata = new WeakMap();
    this._expressionCache = new WeakMap();
    this._sourceValues = new Map();
    this._sourceVersions = new Map();
    this._sourceSubscriptions = new Map();
    this._sourceGeneration = 0;
    this._sourceSignature = "";
    this._sourceConnection = null;
  }

  setConfig(config) {
    this._config = this._normalizeConfig(config || {});
    this._card = this._config.card;
    this._entityDependencies = this._collectEntityDependencies(this._config);
    this._expressionMetadata = new WeakMap();
    this._expressionCache = new WeakMap();
    this._syncDataSources();
    this._render();
  }

  set hass(hass) {
    const previous = this._hass;
    this._hass = hass;
    this._syncDataSources();
    if (!previous || this._dependenciesChanged(previous, hass)) this._render();
  }

  connectedCallback() {
    this._syncDataSources();
  }

  disconnectedCallback() {
    this._unsubscribeDataSources();
  }

  getCardSize() {
    const blocks = this._card?.layout?.blocks || [];
    return Math.max(3, Math.min(12, Math.ceil(blocks.length / 2) + 2));
  }

  _syncDataSources() {
    const sources = (this._card?.data_sources || []).slice(0, 4);
    const signature = JSON.stringify(sources.map((source) => [source.id, source.type, source.entity, source.forecast_type, source.limit || 5]));
    const connection = this._hass?.connection;
    if (
      signature === this._sourceSignature
      && connection === this._sourceConnection
      && this._sourceSubscriptions.size === sources.length
    ) return;
    this._unsubscribeDataSources();
    this._sourceSignature = signature;
    this._sourceConnection = connection || null;
    if (!this.isConnected || !connection?.subscribeMessage || !sources.length) return;
    const generation = this._sourceGeneration;
    for (const source of sources) {
      if (source.type !== "weather_forecast") continue;
      const limit = this._clampInt(source.limit, 1, 16, 5);
      this._sourceValues.set(source.id, { status: "loading", type: source.forecast_type, forecast: [] });
      this._sourceVersions.set(source.id, 1);
      const subscription = Promise.resolve().then(() => connection.subscribeMessage(
        (event) => {
          if (generation !== this._sourceGeneration || !this.isConnected) return;
          this._sourceValues.set(source.id, this._sanitizeForecastEvent(event, source.forecast_type, limit));
          this._sourceVersions.set(source.id, (this._sourceVersions.get(source.id) || 0) + 1);
          this._expressionCache = new WeakMap();
          this._render();
        },
        {
          type: "weather/subscribe_forecast",
          entity_id: source.entity,
          forecast_type: source.forecast_type,
        },
      )).catch(() => {
        if (generation === this._sourceGeneration && this.isConnected) {
          this._sourceValues.set(source.id, { status: "error", type: source.forecast_type, forecast: [] });
          this._sourceVersions.set(source.id, (this._sourceVersions.get(source.id) || 0) + 1);
          this._expressionCache = new WeakMap();
          this._render();
        }
        return null;
      });
      this._sourceSubscriptions.set(source.id, subscription);
    }
  }

  _unsubscribeDataSources() {
    this._sourceGeneration += 1;
    for (const subscription of this._sourceSubscriptions.values()) {
      subscription.then((unsubscribe) => {
        if (typeof unsubscribe === "function") unsubscribe();
      });
    }
    this._sourceSubscriptions.clear();
    this._sourceValues.clear();
    this._sourceVersions.clear();
    this._expressionCache = new WeakMap();
  }

  _sanitizeForecastEvent(event, fallbackType, limit) {
    const forecast = (Array.isArray(event?.forecast) ? event.forecast : []).slice(0, limit).map((entry) => {
      const clean = {};
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return clean;
      for (const [key, value] of Object.entries(entry)) {
        if (FORECAST_FIELDS.has(key) && ["string", "number", "boolean"].includes(typeof value)) clean[key] = value;
      }
      return clean;
    });
    return {
      status: "ready",
      type: ["daily", "hourly", "twice_daily"].includes(event?.type) ? event.type : fallbackType,
      forecast,
    };
  }

  _normalizeConfig(config) {
    const normalized = { ...config, urdash_schema_minor: config.urdash_schema_minor ?? 0 };
    const diagnostics = validateSchema(normalized, CARD_SCHEMA);
    if (diagnostics.length) {
      const error = new Error(`UrDash config invalid at ${diagnostics[0].path}: ${diagnostics[0].message}`);
      error.diagnostics = diagnostics;
      throw error;
    }
    return normalized;
  }

  _render() {
    if (!this.shadowRoot || !this._card) return;
    const layout = this._card.layout || {};
    const intent = this._card.intent || {};
    const heightMode = this._safeEnum(this._config.height_mode, ["auto", "viewport", "fixed"], "auto");
    const theme = this._safeEnum(layout.theme, ["aurora", "quiet", "graphite", "calm", "sunrise"], "aurora");
    const density = this._safeEnum(layout.density, ["compact", "comfortable", "spacious"], "comfortable");
    const type = this._safeEnum(layout.type, ["grid", "canvas"], "grid");
    const chrome = this._safeEnum(layout.chrome, ["normal", "art"], "normal");
    const showRisk = this._config.preview === true || this._config.preview_mode === true;

    this.shadowRoot.innerHTML = `
      <style>${styles}</style>
      <article class="urdash-card theme-${theme} density-${density} height-${heightMode} layout-${type} chrome-${chrome}">
        ${chrome === "art" ? "" : `<header class="card-header">
          <div>
            <span>${escapeHtml(intent.goal || "urdash")}</span>
            <h3>${escapeHtml(intent.title || "UrDash Card")}</h3>
            <p>${escapeHtml(intent.summary || "")}</p>
          </div>
          ${showRisk ? `<div class="risk risk-${this._risk(intent.risk_level)}">${escapeHtml(intent.risk_level || "low")}</div>` : ""}
        </header>`}
        <section class="block-stage"></section>
      </article>
    `;

    const shell = this.shadowRoot.querySelector(".urdash-card");
    if (this._config.height) shell.style.setProperty("--urdash-card-height", `${Number(this._config.height) || 720}px`);
    const stage = this.shadowRoot.querySelector(".block-stage");
    if (type === "grid") {
      stage.style.setProperty("--urdash-columns", String(this._clampInt(layout.columns, 4, 16, 12)));
    } else {
      stage.style.setProperty("--urdash-aspect", this._safeAspect(layout.aspect_ratio));
      stage.style.setProperty("--urdash-mobile-aspect", this._safeAspect(layout.responsive?.mobile?.aspect_ratio || layout.mobile_aspect_ratio || "4/5"));
    }

    for (const blockConfig of (layout.blocks || []).slice(0, 48)) {
      if (this._isVisible(blockConfig)) stage.appendChild(this._createBlock(blockConfig, type));
    }
  }

  _createBlock(config, layoutType) {
    const block = document.createElement("section");
    block.className = [
      "block",
      `block-${this._safeKind(config.kind)}`,
      this._styleClasses(config.style),
      this._presentationClasses(config.presentation),
      this._animationClasses(config.animation),
    ].join(" ");
    block.dataset.blockId = config.id || "";
    block.style.setProperty("--accent", this._safeAccent(this._resolveDisplay(config.style?.accent)));

    if (layoutType === "grid") this._applyGrid(block, config.grid);
    else this._applyFrame(block, config.frame, config.responsive?.mobile?.frame);

    if (this._shouldRenderHeader(config)) {
      block.appendChild(this._createBlockHeader(config));
    }

    const body = document.createElement("div");
    body.className = "block-body";
    body.appendChild(this._createBlockBody(config));
    block.appendChild(body);
    this._makeBlockActionable(block, config);
    return block;
  }

  _makeBlockActionable(block, config) {
    const passiveKinds = new Set([
      "text", "icon", "vector_icon", "value", "value_cluster", "entity_list",
      "gauge", "radial_meter", "timeline", "sparkline", "hero_value", "ambient",
    ]);
    if (!passiveKinds.has(config.kind) || !this._actionAllowed(config.action)) return;
    block.classList.add("block-actionable");
    block.setAttribute("role", "button");
    block.tabIndex = 0;
    block.addEventListener("click", (event) => {
      if (event.target?.closest?.("button,input,select")) return;
      this._runAction(config.action, { element: block });
    });
    block.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      this._runAction(config.action, { element: block });
    });
  }

  _createBlockHeader(config) {
    const header = document.createElement("div");
    header.className = "block-header";
    this._appendResolvedIcon(header, config, this._resolveDisplay(config.title) || "Block icon", "block-header-icon");
    const text = document.createElement("div");
    const titleValue = this._resolveDisplay(config.title);
    if (titleValue) {
      const title = document.createElement("h4");
      title.textContent = titleValue;
      text.appendChild(title);
    }
    const subtitleValue = this._resolveDisplay(config.subtitle);
    if (subtitleValue) {
      const subtitle = document.createElement("p");
      subtitle.textContent = subtitleValue;
      text.appendChild(subtitle);
    }
    header.appendChild(text);
    return header;
  }

  _shouldRenderHeader(config) {
    if (!(config.title || config.subtitle || config.icon || config.icon_ref)) return false;
    if (["ambient", "hero_value", "entity_orbit", "constellation", "radial_scene"].includes(config.kind)) return false;
    if (["naked", "orb"].includes(config.presentation?.surface)) return false;
    return true;
  }

  _createBlockBody(config) {
    switch (config.kind) {
      case "text":
        return this._textBlock(config);
      case "icon":
        return this._iconBlock(config);
      case "vector_icon":
        return this._vectorIcon(config);
      case "value":
        return this._valueBlock(config);
      case "value_cluster":
        return this._valueCluster(config);
      case "entity_list":
        return this._entityList(config.entities || []);
      case "button":
        return this._button(config);
      case "button_group":
        return this._buttonGroup(config.buttons || []);
      case "toggle_group":
        return this._toggleGroup(config.entities || []);
      case "segmented_control":
        return this._segmentedControl(config);
      case "slider":
        return this._slider(config);
      case "climate_control":
        return this._climateControl(config.entity);
      case "cover_control":
        return this._coverControl(config.entity);
      case "security_cluster":
        return this._securityCluster(config.entities || []);
      case "scene_strip":
        return this._sceneStrip(config.actions || []);
      case "gauge":
      case "radial_meter":
        return this._meter(config);
      case "timeline":
        return this._timeline(config.entities || []);
      case "sparkline":
        return this._sparkline(config);
      case "divider":
        return document.createElement("hr");
      case "chip_group":
        return this._chipGroup(config.chips || []);
      case "hero_value":
        return this._heroValue(config);
      case "ambient":
        return this._ambient(config);
      case "entity_orbit":
        return this._entityOrbit(config);
      case "constellation":
        return this._constellation(config);
      case "radial_scene":
        return this._radialScene(config);
      case "visual_map":
        return this._visualMap(config);
      case "component_tree":
        return this._componentTree(config);
      default:
        return this._empty(`Unsupported block: ${config.kind || "unknown"}`);
    }
  }

  _textBlock(config) {
    const wrap = document.createElement("div");
    wrap.className = `text text-${this._safeEnum(config.variant, ["label", "body", "headline", "display", "title", "caption"], "body")}`;
    const text = document.createElement("p");
    text.textContent = this._resolveDisplay(config.text ?? config.title ?? "");
    wrap.appendChild(text);
    return wrap;
  }

  _componentTree(config) {
    const root = document.createElement("div");
    root.className = "component-tree";
    const component = this._componentNode(config.component, 1);
    if (component) root.appendChild(component);
    else root.appendChild(this._empty("No component tree configured."));
    return root;
  }

  _componentNode(config, depth) {
    if (!config || typeof config !== "object" || depth > 6 || !this._componentVisible(config)) return null;
    const type = this._safeEnum(config.type, [
      "row", "column", "stack", "wrap", "surface", "text", "icon", "value",
      "toggle", "slider", "color_picker", "select", "button", "progress", "divider", "spacer",
    ], "spacer");
    if (["row", "column", "stack", "wrap", "surface"].includes(type)) {
      const container = document.createElement("div");
      this._configureComponentElement(container, config, type);
      for (const child of (config.children || []).slice(0, 16)) {
        const element = this._componentNode(child, depth + 1);
        if (element) container.appendChild(element);
      }
      if (type === "surface") this._makeComponentActionable(container, config);
      return container;
    }
    if (type === "text") {
      const text = document.createElement("span");
      this._configureComponentElement(text, config, type);
      text.textContent = this._resolveDisplay(config.text ?? config.label ?? "");
      return text;
    }
    if (type === "icon") {
      const icon = document.createElement("span");
      this._configureComponentElement(icon, config, type);
      if (!this._appendResolvedIcon(icon, config, this._resolveDisplay(config.label) || "Component icon", "component-asset-icon")) {
        icon.appendChild(this._icon("mdi:view-dashboard"));
      }
      return icon;
    }
    if (type === "value") {
      const value = document.createElement("div");
      this._configureComponentElement(value, config, type);
      const strong = document.createElement("strong");
      strong.textContent = this._formatValue(this._componentValue(config), this._componentUnit(config));
      value.appendChild(strong);
      const label = this._resolveDisplay(config.label);
      if (label) value.appendChild(this._label(label));
      return value;
    }
    if (type === "toggle") return this._componentToggle(config);
    if (type === "slider") return this._componentSlider(config);
    if (type === "color_picker") return this._componentColorPicker(config);
    if (type === "select") return this._componentSelect(config);
    if (type === "button") {
      const button = this._actionButton(config.label || config.text || "Action", config.icon, config.action, config.icon_ref);
      this._configureComponentElement(button, config, type);
      if (this._componentDisabled(config)) button.disabled = true;
      return button;
    }
    if (type === "progress") {
      const progress = document.createElement("progress");
      this._configureComponentElement(progress, config, type);
      const minimum = Number(config.range?.min ?? 0);
      const maximum = Number(config.range?.max ?? 100);
      progress.max = maximum;
      progress.value = this._clampNumber(this._componentValue(config), minimum, maximum, minimum);
      progress.setAttribute("aria-label", this._resolveDisplay(config.label) || "Progress");
      return progress;
    }
    if (type === "divider") {
      const divider = document.createElement("hr");
      this._configureComponentElement(divider, config, type);
      return divider;
    }
    const spacer = document.createElement("span");
    this._configureComponentElement(spacer, config, type);
    return spacer;
  }

  _configureComponentElement(element, config, type) {
    element.classList.add(
      "component",
      `component-${type}`,
      `component-surface-${this._safeEnum(config.style?.surface, ["none", "soft", "glass", "solid", "ghost"], "none")}`,
      `component-shape-${this._safeEnum(config.style?.shape, ["square", "soft", "pill", "circle"], "soft")}`,
      `component-tone-${config.style?.tone ? this._safeEnum(config.style.tone, ["neutral", "calm", "warm", "cool", "alert", "success"], "neutral") : "inherit"}`,
      `component-emphasis-${this._safeEnum(config.style?.emphasis, ["low", "normal", "high"], "normal")}`,
      `component-size-${this._safeEnum(config.style?.size, ["xs", "sm", "md", "lg", "xl"], "md")}`,
      `component-gap-${this._safeEnum(config.layout?.gap, ["none", "xs", "sm", "md", "lg"], "sm")}`,
      `component-direction-${this._safeEnum(config.layout?.direction, ["row", "column"], "row")}`,
      `component-padding-${this._safeEnum(config.layout?.padding, ["none", "xs", "sm", "md", "lg"], "none")}`,
      `component-align-${this._safeEnum(config.layout?.align, ["start", "center", "end", "stretch"], "center")}`,
      `component-justify-${this._safeEnum(config.layout?.justify, ["start", "center", "end", "between", "around"], "start")}`,
      `component-width-${this._safeEnum(config.layout?.width, ["auto", "fill", "content"], "auto")}`,
      `component-place-${this._safeEnum(config.layout?.placement, ["center", "top", "right", "bottom", "left", "top_left", "top_right", "bottom_left", "bottom_right"], "center")}`,
    );
    if (config.id) element.dataset.componentId = this._safeKind(config.id);
    const accent = this._resolveDisplay(config.style?.accent);
    if (accent) element.style.setProperty("--component-accent", this._safeAccent(accent));
    element.style.setProperty("--component-grow", String(this._clampInt(config.layout?.grow, 0, 4, 0)));
    element.style.opacity = String(this._clampNumber(config.style?.opacity, 0, 1, 1));
  }

  _componentValue(config) {
    if (config.bind?.value !== undefined) return this._boundValue(this._state(config.entity), config.bind.value);
    if (config.value !== undefined) return this._isExpression(config.value) ? this._evaluateExpression(config.value) : config.value;
    return this._boundValue(this._state(config.entity), "state");
  }

  _componentUnit(config) {
    if (config.bind?.unit !== undefined) return this._boundValue(this._state(config.entity), config.bind.unit);
    if (config.unit !== undefined) return this._isExpression(config.unit) ? this._evaluateExpression(config.unit) : config.unit;
    return this._boundValue(this._state(config.entity), "attributes.unit_of_measurement");
  }

  _componentVisible(config) {
    if (config.visibility === undefined) return true;
    return Boolean(this._isExpression(config.visibility) ? this._evaluateExpression(config.visibility) : config.visibility);
  }

  _componentDisabled(config) {
    if (config.disabled === undefined) return false;
    return Boolean(this._isExpression(config.disabled) ? this._evaluateExpression(config.disabled) : config.disabled);
  }

  _componentToggle(config) {
    const state = this._state(config.entity);
    const active = Boolean(this._isExpression(config.value) ? this._evaluateExpression(config.value) : config.value !== undefined ? config.value : state && !["off", "closed", "locked", "idle", "unavailable", "unknown"].includes(state.state));
    const button = document.createElement("button");
    button.type = "button";
    this._configureComponentElement(button, config, "toggle");
    button.classList.toggle("active", active);
    button.setAttribute("role", "switch");
    button.setAttribute("aria-checked", String(active));
    button.setAttribute("aria-label", this._resolveDisplay(config.label) || this._stateName(state) || "Toggle");
    const thumb = document.createElement("span");
    button.appendChild(thumb);
    const action = config.action || this._toggleActionFor(config.entity || "", state);
    button.disabled = this._componentDisabled(config) || !this._actionAllowed(action);
    button.addEventListener("click", () => this._runAction(action, { current: state?.state, element: button }));
    return button;
  }

  _componentSlider(config) {
    const state = this._state(config.entity);
    const input = document.createElement("input");
    input.type = "range";
    this._configureComponentElement(input, config, "slider");
    input.min = String(config.range?.min ?? 0);
    input.max = String(config.range?.max ?? 100);
    input.step = String(config.range?.step ?? 1);
    const value = Number(this._componentValue(config));
    input.value = String(Number.isFinite(value) ? value : Number(input.min));
    input.disabled = this._componentDisabled(config) || !this._actionAllowed(config.action);
    input.setAttribute("aria-label", this._resolveDisplay(config.label) || this._stateName(state) || "Value");
    input.addEventListener("change", () => this._runAction(config.action, {
      value: Number(input.value),
      current: Number(state?.state),
      element: input,
    }));
    return input;
  }

  _componentColorPicker(config) {
    const state = this._state(config.entity);
    const input = document.createElement("input");
    input.type = "color";
    this._configureComponentElement(input, config, "color-picker");
    input.value = this._rgbToHex(this._componentValue(config) || state?.attributes?.rgb_color);
    input.disabled = this._componentDisabled(config) || !this._actionAllowed(config.action);
    input.setAttribute("aria-label", this._resolveDisplay(config.label) || this._stateName(state) || "Light color");
    input.addEventListener("change", () => this._runAction(config.action, {
      value: this._hexToRgb(input.value),
      current: state?.attributes?.rgb_color,
      element: input,
    }));
    return input;
  }

  _componentSelect(config) {
    const state = this._state(config.entity);
    const select = document.createElement("select");
    this._configureComponentElement(select, config, "select");
    const current = this._componentValue(config);
    for (const option of (config.options || []).slice(0, 32)) {
      const element = document.createElement("option");
      element.value = String(option.value);
      element.textContent = String(option.label);
      element.selected = String(current ?? "") === element.value;
      select.appendChild(element);
    }
    select.disabled = this._componentDisabled(config) || !select.options.length || !this._actionAllowed(config.action);
    select.setAttribute("aria-label", this._resolveDisplay(config.label) || this._stateName(state) || "Select option");
    select.addEventListener("change", () => this._runAction(config.action, {
      selected: select.value,
      value: select.value,
      current,
      element: select,
    }));
    return select;
  }

  _rgbToHex(value) {
    const rgb = Array.isArray(value) ? value : [255, 255, 255];
    return `#${rgb.slice(0, 3).map((part) => this._clampInt(part, 0, 255, 255).toString(16).padStart(2, "0")).join("")}`;
  }

  _hexToRgb(value) {
    const match = String(value || "").match(/^#([0-9a-f]{6})$/i);
    if (!match) return [255, 255, 255];
    return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
  }

  _makeComponentActionable(element, config) {
    if (this._componentDisabled(config) || !this._actionAllowed(config.action)) return;
    element.classList.add("component-actionable");
    element.setAttribute("role", "button");
    element.tabIndex = 0;
    const run = () => this._runAction(config.action, { current: this._state(config.entity)?.state, element });
    element.addEventListener("click", (event) => {
      if (event.target?.closest?.("button,input,select")) return;
      run();
    });
    element.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      run();
    });
  }

  _iconBlock(config) {
    const wrap = document.createElement("div");
    wrap.className = "icon-orb";
    if (!this._appendResolvedIcon(wrap, config, this._resolveDisplay(config.label) || "Icon", "icon-orb-asset")) {
      wrap.appendChild(this._icon("mdi:view-dashboard"));
    }
    return wrap;
  }

  _vectorIcon(config) {
    const wrap = document.createElement("div");
    wrap.className = "vector-icon";
    wrap.appendChild(this._vectorSvg(config, config.label || config.title || "UrDash vector icon"));
    return wrap;
  }

  _vectorSvg(config = {}, label = "UrDash vector icon") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const viewBox = this._safeViewBox(config.viewBox || config.viewbox);
    const metrics = this._vectorViewBoxMetrics(viewBox);
    const budget = this._vectorBudget(config);
    const coordinateMode = this._safeEnum(config.coordinate_mode ?? config.coordinateMode, ["percent", "number"], "percent");
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
    svg.style.setProperty("--vector-accent", this._safeAccent(this._resolveDisplay(config.style?.accent)));
    const gradientIds = this._vectorGradients(svg, config.gradients, metrics, budget);

    for (const shape of (config.shapes || []).slice(0, budget.shapes)) {
      const element = this._vectorShape(shape, gradientIds, 0, metrics, coordinateMode, budget, svg);
      if (element) svg.appendChild(element);
    }
    if (!svg.children.length) {
      const fallback = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      fallback.setAttribute("cx", "50");
      fallback.setAttribute("cy", "50");
      fallback.setAttribute("r", "28");
      fallback.setAttribute("fill", "none");
      fallback.setAttribute("stroke", "var(--vector-accent, var(--accent))");
      fallback.setAttribute("stroke-width", "8");
      svg.appendChild(fallback);
    }
    return svg;
  }

  _vectorGradients(svg, gradients = [], metrics = this._vectorViewBoxMetrics(), budget = this._vectorBudget()) {
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const ids = new Map();
    for (const [index, gradient] of (gradients || []).slice(0, budget.gradients).entries()) {
      const rawId = this._safeGradientId(gradient.id || `g${index}`);
      if (!rawId || ids.has(rawId)) continue;
      const type = this._safeEnum(gradient.type, ["linear", "radial"], "linear");
      const element = document.createElementNS("http://www.w3.org/2000/svg", type === "radial" ? "radialGradient" : "linearGradient");
      const domId = `urdash-vector-${Math.random().toString(36).slice(2)}-${rawId}`;
      element.setAttribute("id", domId);
      element.setAttribute("spreadMethod", this._safeEnum(gradient.spread_method ?? gradient.spreadMethod, ["pad", "reflect", "repeat"], "pad"));
      const units = this._safeEnum(gradient.units, ["objectBoundingBox", "userSpaceOnUse"], "objectBoundingBox");
      element.setAttribute("gradientUnits", units);
      const coordinateMode = this._safeEnum(gradient.coordinate_mode ?? gradient.coordinateMode, ["percent", "number"], "percent");
      if (type === "radial") {
        element.setAttribute("cx", this._vectorGradientCoord(gradient.center?.x, units, coordinateMode, 50));
        element.setAttribute("cy", this._vectorGradientCoord(gradient.center?.y, units, coordinateMode, 50));
        element.setAttribute("fx", this._vectorGradientCoord(gradient.focal?.x ?? gradient.fx ?? gradient.center?.x, units, coordinateMode, 50));
        element.setAttribute("fy", this._vectorGradientCoord(gradient.focal?.y ?? gradient.fy ?? gradient.center?.y, units, coordinateMode, 50));
        element.setAttribute("r", this._vectorGradientCoord(gradient.radius, units, coordinateMode, 50));
        if (gradient.fr != null) element.setAttribute("fr", this._vectorGradientCoord(gradient.fr, units, coordinateMode, 0));
      } else {
        element.setAttribute("x1", this._vectorGradientCoord(gradient.from?.x, units, coordinateMode, 0));
        element.setAttribute("y1", this._vectorGradientCoord(gradient.from?.y, units, coordinateMode, 0));
        element.setAttribute("x2", this._vectorGradientCoord(gradient.to?.x, units, coordinateMode, 100));
        element.setAttribute("y2", this._vectorGradientCoord(gradient.to?.y, units, coordinateMode, 100));
      }
      const gradientTransform = this._vectorTransform(gradient.transform, gradient.rotation, 50, 50, metrics);
      if (gradientTransform) element.setAttribute("gradientTransform", gradientTransform);
      for (const stop of (gradient.stops || []).slice(0, budget.stops)) {
        const stopElement = document.createElementNS("http://www.w3.org/2000/svg", "stop");
        stopElement.setAttribute("offset", `${this._clampNumber(stop.offset, 0, 1, 0) * 100}%`);
        stopElement.setAttribute("stop-color", this._vectorStopColor(stop.color));
        stopElement.setAttribute("stop-opacity", String(this._clampNumber(stop.opacity, 0, 1, 1)));
        element.appendChild(stopElement);
      }
      if (element.children.length >= 2) {
        defs.appendChild(element);
        ids.set(rawId, domId);
      }
    }
    if (defs.children.length) svg.appendChild(defs);
    return ids;
  }

  _vectorShape(shape = {}, gradientIds = new Map(), depth = 0, metrics = this._vectorViewBoxMetrics(), inheritedCoordinateMode = "percent", budget = this._vectorBudget(), svg = null) {
    const kind = this._safeEnum(shape.type, ["path", "circle", "ellipse", "rect", "line", "polyline", "group"], "");
    if (!kind) return null;
    const element = document.createElementNS("http://www.w3.org/2000/svg", kind === "group" ? "g" : kind);
    const coordinateMode = this._safeEnum(shape.coordinate_mode ?? shape.coordinateMode, ["percent", "number"], inheritedCoordinateMode);
    let originX = 50;
    let originY = 50;
    if (kind === "group") {
      originX = this._vectorCoord(shape.origin?.x ?? shape.transform?.origin?.x ?? shape.transform_origin?.x ?? shape.transformOrigin?.x, "x", coordinateMode, metrics, 50);
      originY = this._vectorCoord(shape.origin?.y ?? shape.transform?.origin?.y ?? shape.transform_origin?.y ?? shape.transformOrigin?.y, "y", coordinateMode, metrics, 50);
      for (const child of (shape.shapes || []).slice(0, budget.children)) {
        if (depth >= budget.depth) break;
        const childElement = this._vectorShape(child, gradientIds, depth + 1, metrics, coordinateMode, budget, svg);
        if (childElement) element.appendChild(childElement);
      }
      if (!element.children.length) return null;
    } else if (kind === "path") {
      const d = this._safePathData(shape.d, budget.path);
      if (!d) return null;
      element.setAttribute("d", d);
    } else if (kind === "circle") {
      element.setAttribute("cx", String(this._vectorCoord(shape.cx, "x", coordinateMode, metrics, 50)));
      element.setAttribute("cy", String(this._vectorCoord(shape.cy, "y", coordinateMode, metrics, 50)));
      element.setAttribute("r", String(this._vectorSize(shape.r, coordinateMode, metrics, 10)));
      originX = this._vectorCoord(shape.cx, "x", coordinateMode, metrics, 50);
      originY = this._vectorCoord(shape.cy, "y", coordinateMode, metrics, 50);
    } else if (kind === "ellipse") {
      element.setAttribute("cx", String(this._vectorCoord(shape.cx, "x", coordinateMode, metrics, 50)));
      element.setAttribute("cy", String(this._vectorCoord(shape.cy, "y", coordinateMode, metrics, 50)));
      element.setAttribute("rx", String(this._vectorSize(shape.rx, coordinateMode, metrics, 16)));
      element.setAttribute("ry", String(this._vectorSize(shape.ry, coordinateMode, metrics, 28)));
      originX = this._vectorCoord(shape.cx, "x", coordinateMode, metrics, 50);
      originY = this._vectorCoord(shape.cy, "y", coordinateMode, metrics, 50);
    } else if (kind === "rect") {
      const x = this._vectorCoord(shape.x, "x", coordinateMode, metrics, 0);
      const y = this._vectorCoord(shape.y, "y", coordinateMode, metrics, 0);
      const width = this._vectorSize(shape.width, coordinateMode, metrics, 20);
      const height = this._vectorSize(shape.height, coordinateMode, metrics, 20);
      element.setAttribute("x", String(x));
      element.setAttribute("y", String(y));
      element.setAttribute("width", String(width));
      element.setAttribute("height", String(height));
      if (shape.rx != null) element.setAttribute("rx", String(this._vectorSize(shape.rx, coordinateMode, metrics, 0)));
      if (shape.ry != null) element.setAttribute("ry", String(this._vectorSize(shape.ry, coordinateMode, metrics, 0)));
      originX = x + width / 2;
      originY = y + height / 2;
    } else if (kind === "line") {
      element.setAttribute("x1", String(this._vectorCoord(shape.x1, "x", coordinateMode, metrics, 0)));
      element.setAttribute("y1", String(this._vectorCoord(shape.y1, "y", coordinateMode, metrics, 0)));
      element.setAttribute("x2", String(this._vectorCoord(shape.x2, "x", coordinateMode, metrics, 100)));
      element.setAttribute("y2", String(this._vectorCoord(shape.y2, "y", coordinateMode, metrics, 100)));
    } else if (kind === "polyline") {
      const points = (shape.points || [])
        .slice(0, budget.points)
        .map((point) => `${this._vectorCoord(point.x, "x", coordinateMode, metrics, 0)},${this._vectorCoord(point.y, "y", coordinateMode, metrics, 0)}`)
        .join(" ");
      if (!points) return null;
      element.setAttribute("points", points);
    }

    if (kind !== "group") {
      element.setAttribute("fill", this._vectorPaint(shape.fill, ["path", "circle", "ellipse", "rect"].includes(kind) ? "none" : "none", gradientIds));
      element.setAttribute("stroke", this._vectorPaint(shape.stroke, "accent", gradientIds));
      const strokeWidth = coordinateMode === "number"
        ? this._clampNumber(shape.stroke_width ?? shape.strokeWidth, 0, Math.max(20, Math.max(metrics.width, metrics.height) / 8), 4)
        : this._clampNumber(shape.stroke_width ?? shape.strokeWidth, 0, 20, 4);
      element.setAttribute("stroke-width", String(strokeWidth));
      element.setAttribute("stroke-linecap", this._safeEnum(shape.stroke_linecap ?? shape.strokeLinecap, ["butt", "round", "square"], "round"));
      element.setAttribute("stroke-linejoin", this._safeEnum(shape.stroke_linejoin ?? shape.strokeLinejoin, ["miter", "round", "bevel"], "round"));
      element.setAttribute("stroke-miterlimit", String(this._clampNumber(shape.stroke_miterlimit ?? shape.strokeMiterlimit, 1, 20, 4)));
      const dashArray = this._vectorDashArray(shape.stroke_dasharray ?? shape.strokeDasharray);
      if (dashArray) element.style.setProperty("--vector-dash-array", dashArray);
    }
    element.setAttribute("opacity", String(this._clampNumber(shape.opacity, 0, 1, 1)));
    const transform = this._vectorTransform(shape.transform, shape.rotation, originX, originY, metrics, shape.transform_origin ?? shape.transformOrigin);
    if (transform) element.setAttribute("transform", transform);
    this._applyVectorEffects(element, shape, svg);
    this._applyVectorAnimation(element, shape.animation, originX, originY, metrics, coordinateMode);
    return element;
  }

  _applyVectorAnimation(element, animation = {}, originX = 50, originY = 50, metrics = this._vectorViewBoxMetrics(), coordinateMode = "percent") {
    if (this._applyVectorKeyframeAnimation(element, animation, originX, originY, metrics, coordinateMode)) return;
    const preset = this._safeEnum(animation.preset, ["none", "pulse", "breathe", "spin", "orbit", "rain_drop", "drift", "dash_flow", "draw", "twinkle", "fade", "shimmer"], "none");
    if (preset === "none") return;
    const speed = this._safeEnum(animation.speed, ["slow", "normal", "fast"], "normal");
    const intensity = this._safeEnum(animation.intensity, ["subtle", "normal", "strong"], "normal");
    const durations = { slow: "3.6s", normal: "2.4s", fast: "1.35s" };
    const strengths = { subtle: "0.55", normal: "1", strong: "1.55" };
    const duration = animation.duration != null ? `${this._clampNumber(animation.duration, 0.5, 30, Number.parseFloat(durations[speed]))}s` : durations[speed];
    const delay = this._clampNumber(animation.delay, 0, 8, 0);
    const ox = this._vectorCoord(animation.origin?.x, "x", coordinateMode, metrics, originX);
    const oy = this._vectorCoord(animation.origin?.y, "y", coordinateMode, metrics, originY);
    if (preset === "spin" || preset === "orbit") {
      const animate = document.createElementNS("http://www.w3.org/2000/svg", "animateTransform");
      animate.setAttribute("attributeName", "transform");
      animate.setAttribute("type", "rotate");
      animate.setAttribute("from", `0 ${ox} ${oy}`);
      animate.setAttribute("to", `360 ${ox} ${oy}`);
      animate.setAttribute("dur", duration);
      animate.setAttribute("begin", `${delay}s`);
      animate.setAttribute("repeatCount", "indefinite");
      animate.setAttribute("additive", "sum");
      element.appendChild(animate);
      return;
    }
    if (preset === "fade") {
      const animate = document.createElementNS("http://www.w3.org/2000/svg", "animate");
      animate.setAttribute("attributeName", "opacity");
      animate.setAttribute("values", "0.32;1;0.32");
      animate.setAttribute("dur", duration);
      animate.setAttribute("begin", `${delay}s`);
      animate.setAttribute("repeatCount", "indefinite");
      element.appendChild(animate);
      return;
    }
    element.classList.add("vector-animated", `vector-anim-${preset}`);
    element.style.setProperty("--vector-duration", duration);
    element.style.setProperty("--vector-delay", `${delay}s`);
    element.style.setProperty("--vector-strength", strengths[intensity]);
    element.style.transformOrigin = `${ox}% ${oy}%`;
    element.style.transformBox = "view-box";
    if (preset === "dash_flow" || preset === "draw") {
      element.setAttribute("pathLength", "100");
    }
  }

  _applyVectorKeyframeAnimation(element, animation = {}, originX = 50, originY = 50, metrics = this._vectorViewBoxMetrics(), coordinateMode = "percent") {
    const keyframes = Array.isArray(animation.keyframes) ? animation.keyframes.slice(0, 8) : [];
    if (keyframes.length < 2) return false;
    const property = this._safeEnum(animation.property, ["opacity", "rotate", "scale", "translate"], "");
    if (!property) return false;
    const speed = this._safeEnum(animation.speed, ["slow", "normal", "fast"], "normal");
    const defaults = { slow: 3.6, normal: 2.4, fast: 1.35 };
    const durationNumber = this._clampNumber(animation.duration, 0.5, 30, defaults[speed]);
    const phase = this._clampNumber(animation.phase_offset ?? animation.phaseOffset, 0, durationNumber, 0);
    const delay = this._clampNumber(animation.delay, 0, 8, 0) - phase;
    const repeat = animation.repeat === false ? "1" : animation.repeat === true || animation.repeat == null ? "indefinite" : String(this._clampInt(animation.repeat, 1, 20, 1));
    const offsets = keyframes.map((frame, index) => this._clampNumber(frame.offset, 0, 1, index / (keyframes.length - 1)));
    const keyTimes = offsets.map((offset, index) => index === 0 ? 0 : Math.max(offset, offsets[index - 1])).join(";");
    const easing = this._safeEnum(animation.easing, ["linear", "ease", "ease_in", "ease_out", "ease_in_out"], "linear");
    const ox = this._vectorCoord(animation.origin?.x, "x", coordinateMode, metrics, originX);
    const oy = this._vectorCoord(animation.origin?.y, "y", coordinateMode, metrics, originY);
    let animate;
    let values = [];
    if (property === "opacity") {
      animate = document.createElementNS("http://www.w3.org/2000/svg", "animate");
      animate.setAttribute("attributeName", "opacity");
      values = keyframes.map((frame) => String(this._clampNumber(frame.opacity ?? frame.value, 0, 1, 1)));
    } else {
      animate = document.createElementNS("http://www.w3.org/2000/svg", "animateTransform");
      animate.setAttribute("attributeName", "transform");
      animate.setAttribute("additive", "sum");
      if (property === "rotate") {
        animate.setAttribute("type", "rotate");
        values = keyframes.map((frame) => `${this._clampNumber(frame.rotate ?? frame.angle ?? frame.value, -360, 360, 0)} ${ox} ${oy}`);
      } else if (property === "scale") {
        animate.setAttribute("type", "scale");
        values = keyframes.map((frame) => {
          const scale = frame.scale ?? frame.value ?? 1;
          const sx = this._clampNumber(frame.scale_x ?? frame.scaleX ?? frame.x ?? scale, 0.1, 4, 1);
          const sy = this._clampNumber(frame.scale_y ?? frame.scaleY ?? frame.y ?? scale, 0.1, 4, 1);
          return `${sx} ${sy}`;
        });
      } else if (property === "translate") {
        animate.setAttribute("type", "translate");
        const limit = this._vectorTranslationLimit(metrics);
        values = keyframes.map((frame) => {
          const x = this._clampNumber(frame.x ?? frame.translate_x ?? frame.translateX, -limit, limit, 0);
          const y = this._clampNumber(frame.y ?? frame.translate_y ?? frame.translateY, -limit, limit, 0);
          return `${x} ${y}`;
        });
      }
    }
    if (!animate || values.length < 2) return false;
    animate.setAttribute("values", values.join(";"));
    animate.setAttribute("keyTimes", keyTimes);
    animate.setAttribute("dur", `${durationNumber}s`);
    animate.setAttribute("begin", `${delay}s`);
    animate.setAttribute("repeatCount", repeat);
    if (easing !== "linear" && keyframes.length > 1) {
      animate.setAttribute("calcMode", "spline");
      animate.setAttribute("keySplines", Array.from({ length: keyframes.length - 1 }, () => this._vectorKeySpline(easing)).join(";"));
    }
    element.appendChild(animate);
    return true;
  }

  _vectorKeySpline(easing) {
    if (easing === "ease_in") return "0.42 0 1 1";
    if (easing === "ease_out") return "0 0 0.58 1";
    if (easing === "ease_in_out") return "0.42 0 0.58 1";
    return "0.25 0.1 0.25 1";
  }

  _vectorDashArray(value) {
    if (Array.isArray(value)) {
      const parts = value.slice(0, 4).map((part) => this._clampNumber(part, 0, 100, 0)).filter((part) => part > 0);
      return parts.length ? parts.join(" ") : "";
    }
    const text = String(value || "").trim();
    if (!text) return "";
    const parts = text.split(/[\s,]+/).slice(0, 4).map((part) => this._clampNumber(part, 0, 100, 0)).filter((part) => part > 0);
    return parts.length ? parts.join(" ") : "";
  }

  _applyVectorEffects(element, shape = {}, svg = null) {
    const blendMode = this._safeEnum(shape.blend_mode ?? shape.blendMode, ["normal", "screen", "plus-lighter", "soft-light", "overlay", "color-dodge", "hard-light", "lighten"], "normal");
    if (blendMode !== "normal") element.style.mixBlendMode = blendMode;
    const effects = shape.effects || {};
    const filters = [];
    const brightness = this._clampNumber(effects.brightness, 0.2, 3, 1);
    const saturate = this._clampNumber(effects.saturate, 0.2, 3, 1);
    if (brightness !== 1) filters.push(`brightness(${brightness})`);
    if (saturate !== 1) filters.push(`saturate(${saturate})`);
    const blur = this._clampNumber(effects.blur, 0, 16, 0);
    if (blur > 0) filters.push(`blur(${blur}px)`);
    const preset = this._safeEnum(effects.filter_preset ?? effects.filterPreset, ["none", "soft_blur", "outer_glow", "inner_glow", "bloom", "colored_shadow", "luminous_ring", "svg_blur", "svg_white_neon"], "none");
    const presetColor = this._vectorCssColor(effects.color || effects.accent || effects.glow?.color || "accent", effects.opacity ?? 0.72);
    if (preset === "svg_blur" || preset === "svg_white_neon") {
      const filterId = this._vectorNativeFilter(svg, preset, effects);
      if (filterId) element.setAttribute("filter", `url(#${filterId})`);
    } else if (preset === "soft_blur") {
      filters.push("blur(3px)", "brightness(1.08)", "saturate(1.08)");
    } else if (preset === "outer_glow") {
      filters.push(`drop-shadow(0 0 10px ${presetColor})`, `drop-shadow(0 0 22px ${presetColor})`);
    } else if (preset === "inner_glow") {
      filters.push("brightness(1.18)", `drop-shadow(0 0 8px ${presetColor})`);
    } else if (preset === "bloom") {
      filters.push("brightness(1.28)", "saturate(1.18)", `drop-shadow(0 0 12px ${presetColor})`, `drop-shadow(0 0 28px ${presetColor})`);
    } else if (preset === "colored_shadow") {
      filters.push(`drop-shadow(0 6px 18px ${presetColor})`);
    } else if (preset === "luminous_ring") {
      filters.push("brightness(1.2)", `drop-shadow(0 0 5px ${presetColor})`, `drop-shadow(0 0 18px ${presetColor})`);
    }
    const glow = effects.glow || {};
    const glowSize = this._clampNumber(glow.size, 0, 40, 0);
    if (glowSize > 0) {
      filters.push(`drop-shadow(0 0 ${glowSize}px ${this._vectorCssColor(glow.color || "accent", glow.opacity)})`);
    }
    const neon = effects.neon_glow || effects.neonGlow || {};
    const neonSize = this._clampNumber(neon.size, 0, 48, 0);
    if (neonSize > 0) {
      const color = this._vectorCssColor(neon.color || glow.color || "accent", neon.opacity ?? glow.opacity ?? 0.72);
      const layers = this._clampInt(neon.layers, 1, 4, 3);
      for (let index = 1; index <= layers; index += 1) {
        filters.push(`drop-shadow(0 0 ${Math.round((neonSize * index) / layers)}px ${color})`);
      }
    }
    if (filters.length) element.style.filter = filters.join(" ");
  }

  _vectorNativeFilter(svg, preset, effects = {}) {
    if (!svg) return "";
    let defs = svg.querySelector("defs");
    if (!defs) {
      defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      svg.prepend(defs);
    }
    const id = `urdash-filter-${Math.random().toString(36).slice(2)}-${preset}`;
    const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    filter.setAttribute("id", id);
    filter.setAttribute("x", "-30%");
    filter.setAttribute("y", "-30%");
    filter.setAttribute("width", "160%");
    filter.setAttribute("height", "160%");
    const blur = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
    blur.setAttribute("stdDeviation", String(this._clampNumber(effects.std_deviation ?? effects.stdDeviation ?? effects.blur, 0, 24, preset === "svg_white_neon" ? 2 : 10)));
    if (preset === "svg_blur") {
      filter.appendChild(blur);
      defs.appendChild(filter);
      return id;
    }
    blur.setAttribute("result", "blurred");
    const flood = document.createElementNS("http://www.w3.org/2000/svg", "feFlood");
    flood.setAttribute("flood-color", this._vectorStopColor(effects.color || "#ffffff"));
    flood.setAttribute("flood-opacity", String(this._clampNumber(effects.opacity, 0, 1, 1)));
    flood.setAttribute("result", "neonColor");
    const composite = document.createElementNS("http://www.w3.org/2000/svg", "feComposite");
    composite.setAttribute("in", "neonColor");
    composite.setAttribute("in2", "blurred");
    composite.setAttribute("operator", "in");
    const merge = document.createElementNS("http://www.w3.org/2000/svg", "feMerge");
    merge.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "feMergeNode"));
    const source = document.createElementNS("http://www.w3.org/2000/svg", "feMergeNode");
    source.setAttribute("in", "SourceGraphic");
    merge.appendChild(source);
    filter.append(blur, flood, composite, merge);
    defs.appendChild(filter);
    return id;
  }

  _vectorTransform(transform = {}, rotationFallback = null, originX = 50, originY = 50, metrics = this._vectorViewBoxMetrics(), originOverride = null) {
    const stack = Array.isArray(transform.transforms ?? transform.stack) ? (transform.transforms ?? transform.stack).slice(0, 8) : null;
    if (stack?.length) {
      return stack.map((item) => this._vectorTransformPart(item, originX, originY, metrics, originOverride)).filter(Boolean).join(" ");
    }
    const parts = [];
    const matrixPart = this._vectorTransformPart({ type: "matrix", ...(transform.matrix || {}) }, originX, originY, metrics, originOverride);
    if (matrixPart && transform.matrix) parts.push(matrixPart);
    const tx = this._clampNumber(transform.translate_x ?? transform.translateX, -100, 100, 0);
    const ty = this._clampNumber(transform.translate_y ?? transform.translateY, -100, 100, 0);
    if (tx || ty) parts.push(`translate(${tx} ${ty})`);
    const rotate = this._clampNumber(transform.rotate ?? rotationFallback, -360, 360, 0);
    const ox = this._vectorCoord(originOverride?.x ?? transform.origin?.x, "x", "number", metrics, originX);
    const oy = this._vectorCoord(originOverride?.y ?? transform.origin?.y, "y", "number", metrics, originY);
    if (rotate) parts.push(`rotate(${rotate} ${ox} ${oy})`);
    const scale = transform.scale ?? undefined;
    const sx = this._clampNumber(transform.scale_x ?? transform.scaleX ?? scale ?? undefined, 0.1, 4, 1);
    const sy = this._clampNumber(transform.scale_y ?? transform.scaleY ?? scale ?? undefined, 0.1, 4, 1);
    if (sx !== 1 || sy !== 1) parts.push(`translate(${ox} ${oy}) scale(${sx} ${sy}) translate(${-ox} ${-oy})`);
    const skewX = this._clampNumber(transform.skew_x ?? transform.skewX, -60, 60, 0);
    const skewY = this._clampNumber(transform.skew_y ?? transform.skewY, -60, 60, 0);
    if (skewX) parts.push(`skewX(${skewX})`);
    if (skewY) parts.push(`skewY(${skewY})`);
    return parts.join(" ");
  }

  _vectorTransformPart(item = {}, originX = 50, originY = 50, metrics = this._vectorViewBoxMetrics(), originOverride = null) {
    const type = this._safeEnum(item.type, ["matrix", "translate", "rotate", "scale", "skew_x", "skew_y"], item.a != null || item.matrix ? "matrix" : "");
    const limit = this._vectorTranslationLimit(metrics);
    if (type === "matrix") {
      const matrix = item.matrix || item;
      const a = this._clampNumber(matrix.a, -4, 4, 1);
      const b = this._clampNumber(matrix.b, -4, 4, 0);
      const c = this._clampNumber(matrix.c, -4, 4, 0);
      const d = this._clampNumber(matrix.d, -4, 4, 1);
      const e = this._clampNumber(matrix.e, -limit, limit, 0);
      const f = this._clampNumber(matrix.f, -limit, limit, 0);
      return `matrix(${a} ${b} ${c} ${d} ${e} ${f})`;
    }
    if (type === "translate") {
      const x = this._clampNumber(item.x ?? item.translate_x ?? item.translateX, -limit, limit, 0);
      const y = this._clampNumber(item.y ?? item.translate_y ?? item.translateY, -limit, limit, 0);
      return x || y ? `translate(${x} ${y})` : "";
    }
    const ox = this._vectorCoord(originOverride?.x ?? item.origin?.x, "x", "number", metrics, originX);
    const oy = this._vectorCoord(originOverride?.y ?? item.origin?.y, "y", "number", metrics, originY);
    if (type === "rotate") {
      const angle = this._clampNumber(item.angle ?? item.rotate, -360, 360, 0);
      return angle ? `rotate(${angle} ${ox} ${oy})` : "";
    }
    if (type === "scale") {
      const scale = item.scale ?? undefined;
      const sx = this._clampNumber(item.x ?? item.scale_x ?? item.scaleX ?? scale ?? undefined, 0.1, 4, 1);
      const sy = this._clampNumber(item.y ?? item.scale_y ?? item.scaleY ?? scale ?? undefined, 0.1, 4, 1);
      return sx !== 1 || sy !== 1 ? `translate(${ox} ${oy}) scale(${sx} ${sy}) translate(${-ox} ${-oy})` : "";
    }
    if (type === "skew_x") {
      const angle = this._clampNumber(item.angle ?? item.skew_x ?? item.skewX, -60, 60, 0);
      return angle ? `skewX(${angle})` : "";
    }
    if (type === "skew_y") {
      const angle = this._clampNumber(item.angle ?? item.skew_y ?? item.skewY, -60, 60, 0);
      return angle ? `skewY(${angle})` : "";
    }
    return "";
  }

  _vectorGradientCoord(value, units, coordinateMode, fallback) {
    if (coordinateMode === "number") {
      return String(this._clampNumber(value, -5000, 5000, fallback));
    }
    const number = units === "userSpaceOnUse"
      ? this._clampNumber(value, -200, 300, fallback)
      : this._clampNumber(value, 0, 100, fallback);
    return units === "userSpaceOnUse" ? String(number) : `${number}%`;
  }

  _vectorCoord(value, axis, coordinateMode, metrics, fallback) {
    if (coordinateMode === "number") {
      const min = axis === "x" ? metrics.minX - metrics.width : metrics.minY - metrics.height;
      const max = axis === "x" ? metrics.minX + metrics.width * 2 : metrics.minY + metrics.height * 2;
      const base = axis === "x" ? metrics.minX : metrics.minY;
      const size = axis === "x" ? metrics.width : metrics.height;
      const numeric = Number(value);
      const fallbackNumber = base + size * (this._clampNumber(fallback, 0, 100, 0) / 100);
      return Number.isFinite(numeric) ? this._clampNumber(numeric, min, max, fallbackNumber) : fallbackNumber;
    }
    return this._clampNumber(value, 0, 100, fallback);
  }

  _vectorSize(value, coordinateMode, metrics, fallback) {
    const max = coordinateMode === "number" ? Math.max(metrics.width, metrics.height) * 2 : 100;
    if (coordinateMode === "number" && !Number.isFinite(Number(value))) {
      return Math.max(metrics.width, metrics.height) * (this._clampNumber(fallback, 0, 100, 0) / 100);
    }
    return this._clampNumber(value, 0, max, fallback);
  }

  _vectorTranslationLimit(metrics = this._vectorViewBoxMetrics()) {
    return Math.max(200, Math.max(metrics.width, metrics.height) * 3);
  }

  _vectorBudget(config = {}) {
    const mode = this._safeEnum(config.render_budget ?? config.renderBudget ?? config.performance_budget ?? config.performanceBudget, ["normal", "art"], "normal");
    return mode === "art"
      ? { shapes: 120, gradients: 24, stops: 16, children: 64, points: 96, depth: 3, path: 2400 }
      : { shapes: 48, gradients: 8, stops: 8, children: 32, points: 32, depth: 2, path: 600 };
  }

  _vectorCssColor(value, opacity = 1) {
    const token = String(value || "accent").trim();
    const alpha = this._clampNumber(opacity, 0, 1, 1);
    const match = token.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
    if (match) {
      const hex = match[1].length === 3 ? match[1].split("").map((char) => char + char).join("") : match[1];
      const number = Number.parseInt(hex, 16);
      const r = (number >> 16) & 255;
      const g = (number >> 8) & 255;
      const b = number & 255;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    if (token === "foreground") return "var(--urdash-fg)";
    if (token === "muted") return "var(--urdash-muted)";
    return "var(--vector-accent, var(--accent))";
  }

  _safeViewBox(value) {
    const text = String(value || "0 0 100 100").trim();
    if (/^-?\d+(\.\d+)?\s+-?\d+(\.\d+)?\s+\d+(\.\d+)?\s+\d+(\.\d+)?$/.test(text)) return text;
    return "0 0 100 100";
  }

  _vectorViewBoxMetrics(value = "0 0 100 100") {
    const parts = this._safeViewBox(value).split(/\s+/).map(Number);
    const width = this._clampNumber(parts[2], 1, 5000, 100);
    const height = this._clampNumber(parts[3], 1, 5000, 100);
    return {
      minX: this._clampNumber(parts[0], -5000, 5000, 0),
      minY: this._clampNumber(parts[1], -5000, 5000, 0),
      width,
      height,
    };
  }

  _safePathData(value, limit = 600) {
    const text = String(value || "").trim().slice(0, limit);
    if (!text || /[^MmZzLlHhVvCcSsQqTtAa0-9,.\-\s]/.test(text)) return "";
    return text;
  }

  _safeGradientId(value) {
    const text = String(value || "").trim();
    return /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(text) ? text : "";
  }

  _vectorStopColor(value) {
    const token = String(value || "accent").trim();
    if (token === "accent") return "var(--vector-accent, var(--accent))";
    if (token === "foreground") return "var(--urdash-fg)";
    if (token === "muted") return "var(--urdash-muted)";
    if (/^#[0-9a-fA-F]{3,8}$/.test(token)) return token;
    return "var(--vector-accent, var(--accent))";
  }

  _vectorPaint(value, fallback, gradientIds = new Map()) {
    const token = String(value || fallback || "none").trim();
    if (token.startsWith("gradient:")) {
      const domId = gradientIds.get(this._safeGradientId(token.slice(9)));
      if (domId) return `url(#${domId})`;
    }
    if (token === "none") return "none";
    if (token === "accent") return "var(--vector-accent, var(--accent))";
    if (token === "foreground") return "var(--urdash-fg)";
    if (token === "muted") return "var(--urdash-muted)";
    if (/^#[0-9a-fA-F]{3,8}$/.test(token)) return token;
    return fallback === "none" ? "none" : "var(--vector-accent, var(--accent))";
  }

  _valueBlock(config) {
    const state = this._state(config.entity);
    const value = this._boundValue(state, config.bind?.value || "state");
    const unit = this._boundValue(state, config.bind?.unit || "attributes.unit_of_measurement");
    const wrap = document.createElement("div");
    wrap.className = "value-readout";
    const strong = document.createElement("strong");
    strong.textContent = this._formatValue(value, unit);
    const label = document.createElement("span");
    label.textContent = this._resolveDisplay(config.label) || this._stateName(state) || config.entity || "Value";
    wrap.append(strong, label);
    return wrap;
  }

  _valueCluster(config) {
    const grid = document.createElement("div");
    grid.className = "value-cluster";
    for (const item of (config.items || []).slice(0, 12)) {
      const state = this._state(item.entity);
      grid.appendChild(this._signalTile(this._resolveDisplay(item.label), this._formatValue(this._boundValue(state, item.value || "state"), this._resolveDisplay(item.unit) || state?.attributes?.unit_of_measurement)));
    }
    if (!grid.children.length) grid.appendChild(this._empty("No values configured."));
    return grid;
  }

  _entityList(entityIds) {
    const list = document.createElement("div");
    list.className = "entity-list";
    for (const entityId of entityIds.slice(0, 12)) list.appendChild(this._entityLine(this._state(entityId), entityId));
    if (!list.children.length) list.appendChild(this._empty("No entities configured."));
    return list;
  }

  _button(config) {
    return this._actionButton(config.label || config.title || "Action", config.icon, config.action, config.icon_ref);
  }

  _buttonGroup(buttons) {
    const group = document.createElement("div");
    group.className = "action-grid";
    for (const button of buttons.slice(0, 8)) group.appendChild(this._actionButton(button.label, button.icon, button.action, button.icon_ref));
    if (!group.children.length) group.appendChild(this._empty("No actions configured."));
    return group;
  }

  _toggleGroup(entityIds) {
    const group = document.createElement("div");
    group.className = "action-grid";
    for (const entityId of entityIds.slice(0, 8)) {
      const state = this._state(entityId);
      group.appendChild(this._actionButton(this._stateName(state) || entityId, this._domainIcon(entityId), this._toggleActionFor(entityId, state)));
    }
    if (!group.children.length) group.appendChild(this._empty("No toggles configured."));
    return group;
  }

  _segmentedControl(config) {
    const wrap = document.createElement("div");
    wrap.className = "segmented-control";
    const state = this._state(config.entity);
    for (const option of (config.options || []).slice(0, 8)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = state?.state === option.value ? "active" : "";
      button.textContent = option.label;
      button.addEventListener("click", () => this._runAction(config.action, {
        selected: option.value,
        current: state?.state,
        element: button,
      }));
      wrap.appendChild(button);
    }
    if (!wrap.children.length) wrap.appendChild(this._empty("No options configured."));
    return wrap;
  }

  _slider(config) {
    const state = this._state(config.entity);
    const input = document.createElement("input");
    input.className = "slider";
    input.type = "range";
    input.min = String(config.range?.min ?? 0);
    input.max = String(config.range?.max ?? 100);
    input.step = String(config.range?.step ?? 1);
    input.value = String(Number(this._boundValue(state, config.bind?.value || "state")) || Number(input.min));
    input.addEventListener("change", () => this._runAction(config.action, {
      value: Number(input.value),
      current: Number(state?.state),
      element: input,
    }));
    return input;
  }

  _climateControl(entityId) {
    const state = this._state(entityId);
    if (!state) return this._missing(entityId);
    const current = state.attributes?.current_temperature ?? state.attributes?.temperature ?? state.state;
    const target = state.attributes?.temperature ?? current;
    const unit = this._hass?.config?.unit_system?.temperature || state.attributes?.unit_of_measurement || "";
    const wrap = document.createElement("div");
    wrap.className = "climate-control";
    const readout = document.createElement("div");
    readout.className = "climate-readout";
    readout.innerHTML = `<strong>${escapeHtml(current)}${escapeHtml(unit)}</strong><span>${escapeHtml(this._humanize(state.state))} mode</span>`;
    const targetBox = document.createElement("div");
    targetBox.className = "climate-target";
    targetBox.append(
      this._smallButton("-", (element) => this._callService("climate", "set_temperature", { entity_id: entityId, temperature: Number(target) - 1 }, element)),
      this._label(`Target ${target}${unit}`),
      this._smallButton("+", (element) => this._callService("climate", "set_temperature", { entity_id: entityId, temperature: Number(target) + 1 }, element)),
    );
    const modes = document.createElement("div");
    modes.className = "segmented-control";
    for (const mode of (state.attributes?.hvac_modes || []).slice(0, 6)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = mode === state.state ? "active" : "";
      button.textContent = this._humanize(mode);
      button.addEventListener("click", () => this._callService("climate", "set_hvac_mode", { entity_id: entityId, hvac_mode: mode }, button));
      modes.appendChild(button);
    }
    wrap.append(readout, targetBox, modes);
    return wrap;
  }

  _coverControl(entityId) {
    const state = this._state(entityId);
    if (!state) return this._missing(entityId);
    const group = document.createElement("div");
    group.className = "action-grid";
    group.append(
      this._actionButton("Open", "mdi:arrow-up", { type: "service", domain: "cover", service: "open_cover", entity_id: entityId }),
      this._actionButton("Stop", "mdi:pause", { type: "service", domain: "cover", service: "stop_cover", entity_id: entityId }),
      this._actionButton("Close", "mdi:arrow-down", { type: "service", domain: "cover", service: "close_cover", entity_id: entityId }),
    );
    return group;
  }

  _securityCluster(entityIds) {
    const wrap = document.createElement("div");
    wrap.className = "security-cluster";
    const states = entityIds.map((entityId) => this._state(entityId)).filter(Boolean);
    const attention = states.filter((state) => ["on", "open", "unlocked", "detected", "triggered", "unavailable"].includes(state.state));
    wrap.appendChild(this._signalTile("Attention", String(attention.length)));
    for (const state of states.slice(0, 6)) wrap.appendChild(this._entityLine(state, state.entity_id));
    if (!states.length) wrap.appendChild(this._empty("No security entities configured."));
    return wrap;
  }

  _sceneStrip(actions) {
    const group = document.createElement("div");
    group.className = "action-grid";
    for (const item of actions.slice(0, 8)) {
      group.appendChild(this._actionButton(item.label, item.icon || "mdi:palette", {
        type: "service",
        domain: "scene",
        service: "turn_on",
        entity_id: item.entity_id,
      }));
    }
    if (!group.children.length) group.appendChild(this._empty("No scenes configured."));
    return group;
  }

  _meter(config) {
    const state = this._state(config.entity);
    const value = Number(this._boundValue(state, config.bind?.value || "state"));
    const min = Number(config.range?.min ?? 0);
    const max = Number(config.range?.max ?? 100);
    const pct = Number.isFinite(value) ? Math.max(0, Math.min(100, ((value - min) / (max - min || 1)) * 100)) : 0;
    const wrap = document.createElement("div");
    wrap.className = config.kind === "radial_meter" ? "radial-meter" : "gauge-meter";
    wrap.style.setProperty("--pct", `${pct}%`);
    wrap.innerHTML = `<strong>${escapeHtml(Number.isFinite(value) ? value : "--")}</strong><span>${escapeHtml(this._stateName(state) || config.entity || "Meter")}</span>`;
    return wrap;
  }

  _timeline(entityIds) {
    const list = document.createElement("div");
    list.className = "timeline";
    for (const entityId of entityIds.slice(0, 8)) {
      const state = this._state(entityId);
      const row = document.createElement("div");
      row.className = "timeline-row";
      row.innerHTML = `<span></span><p>${escapeHtml(this._stateName(state) || entityId)} is ${escapeHtml(this._humanize(state?.state || "missing"))}</p>`;
      list.appendChild(row);
    }
    if (!list.children.length) list.appendChild(this._empty("No timeline entities configured."));
    return list;
  }

  _sparkline(config) {
    const wrap = document.createElement("div");
    wrap.className = "sparkline";
    wrap.appendChild(this._valueBlock(config));
    const line = document.createElement("div");
    line.className = "sparkline-line";
    wrap.appendChild(line);
    return wrap;
  }

  _chipGroup(chips) {
    const group = document.createElement("div");
    group.className = "chip-group";
    for (const chip of chips.slice(0, 12)) {
      const state = this._state(chip.entity);
      const span = document.createElement("span");
      this._appendResolvedIcon(span, chip, this._resolveDisplay(chip.label) || "Chip icon", "chip-asset-icon");
      span.append(document.createTextNode(`${this._resolveDisplay(chip.label)}${state ? ` · ${this._humanize(state.state)}` : ""}`));
      group.appendChild(span);
    }
    if (!group.children.length) group.appendChild(this._empty("No chips configured."));
    return group;
  }

  _heroValue(config) {
    const state = this._state(config.entity);
    const value = this._boundValue(state, config.bind?.value || "state");
    const unit = this._boundValue(state, config.bind?.unit || "attributes.unit_of_measurement");
    const wrap = document.createElement("div");
    wrap.className = "hero-value";
    if (String(value ?? "").length > 5) wrap.classList.add("hero-value-long");
    else wrap.classList.add("hero-value-short");
    this._appendResolvedIcon(wrap, config, this._resolveDisplay(config.label) || "Status icon", "hero-asset-icon");
    const valueEl = document.createElement("strong");
    valueEl.textContent = this._formatValue(value, unit);
    const label = document.createElement("span");
    label.textContent = this._resolveDisplay(config.label) || this._resolveDisplay(config.title) || this._stateName(state) || config.entity || "Status";
    const subtitle = document.createElement("p");
    subtitle.textContent = this._resolveDisplay(config.subtitle) || this._humanize(state?.state || "");
    wrap.append(valueEl, label, subtitle);
    return wrap;
  }

  _ambient(config) {
    const wrap = document.createElement("div");
    wrap.className = "ambient-layer";
    const icon = document.createElement("div");
    icon.className = "ambient-icon";
    if (!this._appendResolvedIcon(icon, config, this._resolveDisplay(config.title) || "Ambient icon", "ambient-asset-icon")) {
      icon.appendChild(this._icon("mdi:creation"));
    }
    const text = document.createElement("div");
    text.className = "ambient-text";
    const title = document.createElement("strong");
    title.textContent = config.title || config.text || "";
    const subtitle = document.createElement("span");
    subtitle.textContent = config.subtitle || "";
    text.append(title, subtitle);
    wrap.append(icon, text);
    return wrap;
  }

  _entityOrbit(config) {
    const states = (config.entities || []).map((entityId) => this._state(entityId)).filter(Boolean);
    const center = this._state(config.entity) || states[0];
    const orbit = document.createElement("div");
    orbit.className = "entity-orbit";
    const core = document.createElement("div");
    core.className = "orbit-core";
    const coreValue = document.createElement("strong");
    coreValue.textContent = center ? this._formatValue(center.state, center.attributes?.unit_of_measurement) : config.title || "Home";
    const coreLabel = document.createElement("span");
    coreLabel.textContent = this._stateName(center) || config.label || "Signals";
    core.append(coreValue, coreLabel);
    orbit.appendChild(core);

    const positions = [
      [50, 5],
      [84, 22],
      [88, 65],
      [50, 90],
      [12, 65],
      [16, 22],
      [68, 48],
      [32, 48],
    ];
    for (const [index, state] of states.slice(0, 8).entries()) {
      const satellite = document.createElement("button");
      satellite.type = "button";
      satellite.className = "orbit-satellite";
      satellite.style.left = `${positions[index][0]}%`;
      satellite.style.top = `${positions[index][1]}%`;
      satellite.textContent = `${this._shortName(state)} ${this._formatValue(state.state, state.attributes?.unit_of_measurement)}`;
      satellite.addEventListener("click", () => this._runAction({ type: "more_info", entity_id: state.entity_id }));
      orbit.appendChild(satellite);
    }
    return orbit;
  }

  _constellation(config) {
    const states = (config.entities || []).map((entityId) => this._state(entityId)).filter(Boolean);
    const wrap = document.createElement("div");
    wrap.className = "constellation";
    const title = document.createElement("strong");
    title.textContent = config.title || "Constellation";
    wrap.appendChild(title);
    for (const [index, state] of states.slice(0, 9).entries()) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "constellation-node";
      item.style.setProperty("--i", index);
      item.append(this._icon(this._domainIcon(state.entity_id)), document.createTextNode(`${this._shortName(state)} · ${this._humanize(state.state)}`));
      item.addEventListener("click", () => this._runAction({ type: "more_info", entity_id: state.entity_id }));
      wrap.appendChild(item);
    }
    if (!states.length) wrap.appendChild(this._empty("No constellation entities configured."));
    return wrap;
  }

  _radialScene(config) {
    const wrap = document.createElement("div");
    wrap.className = "radial-scene";
    const center = document.createElement("div");
    center.className = "radial-scene-center";
    this._appendResolvedIcon(center, config, this._resolveDisplay(config.title) || "Scene icon", "scene-asset-icon");
    const title = document.createElement("strong");
    title.textContent = config.title || "Scene";
    const subtitle = document.createElement("span");
    subtitle.textContent = config.subtitle || "One tap modes";
    center.append(title, subtitle);
    wrap.appendChild(center);

    const actions = (config.actions || []).slice(0, 6);
    const positions = [
      [50, 8],
      [86, 28],
      [80, 72],
      [50, 92],
      [20, 72],
      [14, 28],
    ];
    for (const [index, action] of actions.entries()) {
      const button = this._actionButton(action.label, action.icon || "mdi:palette", {
        type: "service",
        domain: "scene",
        service: "turn_on",
        entity_id: action.entity_id,
      }, action.icon_ref);
      button.classList.add("radial-scene-action");
      button.style.left = `${positions[index][0]}%`;
      button.style.top = `${positions[index][1]}%`;
      wrap.appendChild(button);
    }
    return wrap;
  }

  _visualMap(config) {
    const wrap = document.createElement("div");
    wrap.className = "visual-map";
    const nodes = (config.nodes || []).slice(0, 16).map((node) => ({
      ...node,
      x: this._clampNumber(node.position?.x, 0, 100, 50),
      y: this._clampNumber(node.position?.y, 0, 100, 50),
    }));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "visual-map-links");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    svg.appendChild(defs);

    for (const [index, link] of (config.links || []).slice(0, 24).entries()) {
      const from = nodeById.get(link.from);
      const to = nodeById.get(link.to);
      if (!from || !to) continue;
      const fromPoint = this._visualAnchor(from, link.from_anchor);
      const toPoint = this._visualAnchor(to, link.to_anchor);
      const state = this._state(link.entity);
      const value = Number(this._boundValue(state, link.bind?.value || "state"));
      const animated = this._isExpression(link.style?.animated) ? Boolean(this._evaluateExpression(link.style.animated)) : link.style?.animated;
      const active = Number.isFinite(value) ? Math.abs(value) > 0 : Boolean(state);
      const linkAccent = this._resolveDisplay(link.style?.accent) || this._resolveDisplay(config.style?.accent);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", `visual-link ${animated && active && !link.style?.flow_dot ? "visual-link-animated" : ""}`);
      path.setAttribute("d", this._visualMapPath(fromPoint, toPoint, link));
      path.setAttribute("pathLength", "100");
      path.style.setProperty("--link-accent", this._safeAccent(linkAccent));
      path.style.setProperty("--link-width", `${this._visualLinkWidth(link, value)}px`);
      const markerId = this._visualMarker(defs, config.id, index, linkAccent);
      if (link.style?.direction === "reverse") path.setAttribute("marker-start", `url(#${markerId})`);
      else if (link.style?.direction !== "none") path.setAttribute("marker-end", `url(#${markerId})`);
      svg.appendChild(path);
      if (link.style?.flow_dot) {
        if (animated && active) {
          const tracer = document.createElementNS("http://www.w3.org/2000/svg", "path");
          tracer.setAttribute("class", "visual-flow-tracer");
          tracer.setAttribute("d", path.getAttribute("d"));
          tracer.setAttribute("pathLength", "100");
          tracer.style.setProperty("--link-accent", this._safeAccent(linkAccent));
          tracer.style.setProperty("--flow-width", `${this._clampNumber(link.style?.dot_size, 0.8, 3, 1.1) * 1.45}px`);
          tracer.style.setProperty("--flow-delay", `${-(index % 4) * 0.42}s`);
          svg.appendChild(tracer);
        } else {
          const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          const dotPoint = this._visualFlowDotPoint(fromPoint, toPoint, link);
          dot.setAttribute("class", "visual-flow-dot");
          dot.setAttribute("cx", String(dotPoint.x));
          dot.setAttribute("cy", String(dotPoint.y));
          dot.setAttribute("r", String(this._clampNumber(link.style?.dot_size, 0.8, 4.5, 2.2)));
          dot.style.setProperty("--link-accent", this._safeAccent(linkAccent));
          svg.appendChild(dot);
        }
      }

      const label = document.createElement("span");
      label.className = "visual-link-label";
      label.style.left = `${this._clampNumber(link.label_position?.x, 0, 100, (fromPoint.x + toPoint.x) / 2)}%`;
      label.style.top = `${this._clampNumber(link.label_position?.y, 0, 100, (fromPoint.y + toPoint.y) / 2)}%`;
      label.style.setProperty("--link-accent", this._safeAccent(linkAccent));
      label.textContent = this._visualLinkLabel(link, state);
      label.dataset.linkIndex = String(index);
      if (link.show_label !== false && label.textContent) wrap.appendChild(label);
    }

    wrap.appendChild(svg);

    for (const node of nodes) {
      const state = this._state(node.entity);
      const element = document.createElement(this._actionAllowed(node.action) || node.entity ? "button" : "div");
      element.className = [
        "visual-node",
        `visual-node-${this._safeEnum(node.size, ["micro", "small", "normal", "large", "hero"], "normal")}`,
        `visual-node-${this._safeEnum(node.style?.shape, ["none", "soft", "pill", "circle", "orb", "core", "ring"], "soft")}`,
        `visual-ring-${this._safeEnum(node.style?.ring_width, ["thin", "normal", "thick"], "normal")}`,
      ].join(" ");
      element.style.left = `${node.x}%`;
      element.style.top = `${node.y}%`;
      const nodeAccent = this._resolveDisplay(node.style?.accent) || this._resolveDisplay(config.style?.accent);
      element.style.setProperty("--node-accent", this._safeAccent(nodeAccent));
      if (element.tagName === "BUTTON") {
        element.type = "button";
        element.addEventListener("click", () => this._runAction(
          node.action || { type: "more_info", entity_id: node.entity },
          { element },
        ));
      }
      this._appendResolvedIcon(element, node, this._resolveDisplay(node.label) || node.id || "Node icon", "visual-node-vector-icon", nodeAccent);
      const value = document.createElement("strong");
      value.textContent = this._visualNodeValue(node, state);
      const label = document.createElement("span");
      label.textContent = this._resolveDisplay(node.label) || this._shortName(state) || node.id;
      element.append(value, label);
      const stats = this._visualNodeStats(node);
      if (stats) element.appendChild(stats);
      wrap.appendChild(element);
    }

    if (!nodes.length) wrap.appendChild(this._empty("No visual map nodes configured."));
    return wrap;
  }

  _visualMapPath(from, to, link) {
    const points = (link.path?.points || []).slice(0, 8).map((point) => ({
      x: this._clampNumber(point.x, 0, 100, 50),
      y: this._clampNumber(point.y, 0, 100, 50),
    }));
    if (points.length) {
      const all = [from, ...points, to];
      if (link.style?.curve === "soft" || link.style?.curve === "arc") return this._smoothPolyline(all);
      return all.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
    }
    const curve = link.style?.curve || "soft";
    if (curve === "straight") return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const bend = curve === "arc" ? 0.34 : 0.2;
    const c1x = from.x + dx * bend;
    const c1y = from.y + dy * 0.04;
    const c2x = to.x - dx * bend;
    const c2y = to.y - dy * 0.04;
    return `M ${from.x} ${from.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${to.x} ${to.y}`;
  }

  _visualFlowDotPoint(from, to, link) {
    if (link.flow_position) {
      return {
        x: this._clampNumber(link.flow_position.x, 0, 100, (from.x + to.x) / 2),
        y: this._clampNumber(link.flow_position.y, 0, 100, (from.y + to.y) / 2),
      };
    }
    const points = (link.path?.points || []).slice(0, 8).map((point) => ({
      x: this._clampNumber(point.x, 0, 100, 50),
      y: this._clampNumber(point.y, 0, 100, 50),
    }));
    const route = [from, ...points, to];
    return route[Math.floor(route.length / 2)] || { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  }

  _smoothPolyline(points) {
    if (points.length < 2) return "";
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let index = 1; index < points.length; index += 1) {
      const prev = points[index - 1];
      const current = points[index];
      const midX = (prev.x + current.x) / 2;
      const midY = (prev.y + current.y) / 2;
      path += ` Q ${prev.x} ${prev.y}, ${midX} ${midY}`;
    }
    const last = points[points.length - 1];
    path += ` T ${last.x} ${last.y}`;
    return path;
  }

  _visualAnchor(node, anchor = "center") {
    const offsets = {
      center: [0, 0],
      top: [0, -8],
      right: [8, 0],
      bottom: [0, 8],
      left: [-8, 0],
      top_left: [-6, -6],
      top_right: [6, -6],
      bottom_left: [-6, 6],
      bottom_right: [6, 6],
    };
    const [dx, dy] = offsets[anchor] || offsets.center;
    return {
      x: this._clampNumber(node.x + dx, 0, 100, node.x),
      y: this._clampNumber(node.y + dy, 0, 100, node.y),
    };
  }

  _visualNodeValue(node, state) {
    if (node.value !== undefined) return this._resolveDisplay(node.value);
    return this._formatValue(
      this._boundValue(state, node.bind?.value || "state"),
      this._boundValue(state, node.bind?.unit || "attributes.unit_of_measurement"),
    );
  }

  _visualNodeStats(node) {
    const stats = (node.stats || []).slice(0, 4);
    if (!stats.length) return null;
    const wrap = document.createElement("div");
    wrap.className = "visual-node-stats";
    for (const stat of stats) {
      const state = this._state(stat.entity);
      const row = document.createElement("small");
      row.className = `visual-stat-${this._safeEnum(stat.tone, ["neutral", "positive", "negative", "muted"], "neutral")}`;
      row.textContent = [
        this._resolveDisplay(stat.prefix),
        this._formatValue(this._boundValue(state, stat.bind?.value || "state"), this._resolveDisplay(stat.unit) || this._boundValue(state, stat.bind?.unit || "attributes.unit_of_measurement")),
        this._resolveDisplay(stat.suffix),
      ].join("");
      wrap.appendChild(row);
    }
    return wrap;
  }

  _visualMarker(defs, blockId, index, accent) {
    const markerId = `urdash-arrow-${this._safeKind(blockId || "map")}-${index}`;
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", markerId);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("markerWidth", "5");
    marker.setAttribute("markerHeight", "5");
    marker.setAttribute("refX", "8");
    marker.setAttribute("refY", "5");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    arrow.setAttribute("fill", this._safeAccent(accent));
    marker.appendChild(arrow);
    defs.appendChild(marker);
    return markerId;
  }

  _visualLinkWidth(link, value) {
    if (typeof link.style?.width === "number") return this._clampNumber(link.style.width, 0.4, 10, 3);
    if (link.style?.width !== "dynamic" || !Number.isFinite(value)) return 3;
    return Math.max(2, Math.min(9, 2 + Math.sqrt(Math.abs(value)) / 8));
  }

  _visualLinkLabel(link, state) {
    const label = this._resolveDisplay(link.label);
    if (label && !state) return label;
    if (!state) return label || "";
    const value = this._formatValue(
      this._boundValue(state, link.bind?.value || "state"),
      this._boundValue(state, link.bind?.unit || "attributes.unit_of_measurement"),
    );
    return label ? `${label} ${value}` : value;
  }

  _actionButton(label, icon, action, iconRef = null) {
    const button = document.createElement("button");
    button.className = "action-button";
    button.type = "button";
    this._appendResolvedIcon(button, { icon, icon_ref: iconRef }, this._resolveDisplay(label) || "Action icon", "action-asset-icon");
    const text = document.createElement("span");
    text.textContent = this._resolveDisplay(label) || "Action";
    button.appendChild(text);
    button.disabled = !this._actionAllowed(action);
    if (button.disabled) button.title = "Action unavailable or denied by UrDash policy.";
    button.addEventListener("click", () => this._runAction(action, { element: button }));
    return button;
  }

  async _runAction(action, context = {}) {
    if (!this._actionAllowed(action)) return;
    if (this._requiresConfirmation(action) && !window.confirm(action.confirmation?.text || "Run this action?")) return;
    if (action.type === "more_info") {
      this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: action.entity_id } }));
      return;
    }
    if (action.type === "navigate" && this._navigationAllowed(action.navigation_path)) {
      history.pushState(null, "", action.navigation_path);
      window.dispatchEvent(new CustomEvent("location-changed"));
      return;
    }
    if (action.type !== "service") return;
    const data = this._resolveActionData(action.data || {}, context);
    const policy = this._servicePolicy(action.domain, action.service);
    if (!this._actionDataAllowed(action, policy, data, false)) return;
    await this._executeService(action, { ...data, entity_id: action.entity_id }, context.element);
  }

  async _callService(domain, service, data, element = null) {
    const entityId = data?.entity_id;
    const actionData = { ...(data || {}) };
    delete actionData.entity_id;
    await this._runAction(
      { type: "service", domain, service, entity_id: entityId, data: actionData },
      { element },
    );
  }

  _actionAllowed(action) {
    if (!action || action.type === "none") return false;
    if (action.type === "more_info") return Boolean(this._state(action.entity_id));
    if (action.type === "navigate") return this._navigationAllowed(action.navigation_path);
    if (action.type !== "service" || !this._hass) return false;
    const entity = this._state(action.entity_id);
    if (
      !entity
      || ["unknown", "unavailable"].includes(entity.state)
      || action.entity_id.split(".", 1)[0] !== action.domain
    ) return false;
    if (this._hass.services && !this._hass.services[action.domain]?.[action.service]) return false;
    const policy = this._servicePolicy(action.domain, action.service);
    return Boolean(policy)
      && this._entitySupportsPolicy(entity, policy)
      && this._actionDataAllowed(action, policy, action.data || {}, true);
  }

  _serviceAllowed(domain, service) {
    return Boolean(this._servicePolicy(domain, service));
  }

  _requiresConfirmation(action) {
    return action?.confirmation?.required || this._actionRisk(action) === "high";
  }

  _servicePolicy(domain, service) {
    return ACTION_MANIFEST.domains?.[domain]?.services?.[service] || null;
  }

  _navigationAllowed(path) {
    const value = String(path || "");
    return /^\/(?!\/)[A-Za-z0-9_~!$&'()*+,;=:@%./?-]*$/.test(value) && !value.includes("\\");
  }

  _entitySupportsPolicy(entity, policy) {
    const features = Number(entity?.attributes?.supported_features || 0);
    if (policy.required_attribute && entity?.attributes?.[policy.required_attribute] == null) return false;
    if (features === 0 && policy.allow_zero_features === true) return true;
    if (policy.supported_feature != null && !(features & Number(policy.supported_feature))) return false;
    if (
      Array.isArray(policy.supported_features_any)
      && policy.supported_features_any.length
      && !policy.supported_features_any.some((flag) => features & Number(flag))
    ) return false;
    if (
      Array.isArray(policy.supported_features_all)
      && policy.supported_features_all.some((flag) => !(features & Number(flag)))
    ) return false;
    return true;
  }

  _actionRisk(action) {
    const policy = this._servicePolicy(action?.domain, action?.service);
    let risk = this._safeEnum(policy?.risk, ["low", "medium", "high"], "low");
    const state = this._state(action?.entity_id);
    const deviceClass = state?.attributes?.device_class;
    if (
      action?.domain === "cover"
      && ["open_cover", "set_cover_position"].includes(action?.service)
      && ["door", "garage", "gate"].includes(deviceClass)
    ) risk = "high";
    if (
      action?.domain === "valve"
      && ["open_valve", "set_valve_position"].includes(action?.service)
      && ["gas", "water"].includes(deviceClass)
    ) risk = "high";
    return risk;
  }

  _actionDataAllowed(action, policy, data, allowTemplates) {
    if (!policy || !data || typeof data !== "object" || Array.isArray(data)) return false;
    const parameters = policy.parameters || {};
    const required = policy.required || [];
    if (required.some((name) => !(name in data))) return false;
    if ((policy.required_any || []).some((group) => !group.some((name) => name in data))) return false;
    for (const [name, value] of Object.entries(data)) {
      const parameter = parameters[name];
      if (!parameter || !this._parameterAllowed(parameter, value, allowTemplates)) return false;
      if (!allowTemplates && !this._entityParameterAllowed(action, name, value)) return false;
    }
    return true;
  }

  _parameterAllowed(parameter, value, allowTemplates) {
    if (allowTemplates && this._isExpression(value)) return true;
    if (allowTemplates && this._isActionTemplate(value)) return true;
    if (typeof value === "string" && value.startsWith("$")) return false;
    if (parameter.type === "number" || parameter.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (parameter.type === "integer" && !Number.isInteger(value)) return false;
      if (parameter.min != null && value < Number(parameter.min)) return false;
      if (parameter.max != null && value > Number(parameter.max)) return false;
      return true;
    }
    if (parameter.type === "boolean") return typeof value === "boolean";
    if (parameter.type === "rgb") {
      return Array.isArray(value)
        && value.length === 3
        && value.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
    }
    if (parameter.type === "string_list") {
      return Array.isArray(value)
        && value.length <= Number(parameter.max_items || 16)
        && value.every((part) => typeof part === "string" && part.length <= Number(parameter.max_length || 256));
    }
    if (typeof value !== "string" || value.length > Number(parameter.max_length || 256)) return false;
    if (parameter.type === "duration" && !/^\d{1,3}:\d{2}(?::\d{2})?$/.test(value)) return false;
    return parameter.type !== "enum" || (parameter.options || []).includes(value);
  }

  _entityParameterAllowed(action, name, value) {
    const state = this._state(action.entity_id);
    if (!state) return false;
    const attributes = state.attributes || {};
    const optionAttributes = {
      activity: "activity_list",
      effect: "effect_list",
      fan_mode: "fan_modes",
      fan_speed: "fan_speed_list",
      hvac_mode: "hvac_modes",
      mode: "available_modes",
      operation_mode: "operation_list",
      option: "options",
      preset_mode: "preset_modes",
      sound_mode: "sound_mode_list",
      source: "source_list",
      swing_horizontal_mode: "swing_horizontal_modes",
      swing_mode: "swing_modes",
      tone: "available_tones",
    };
    const options = attributes[optionAttributes[name]];
    if (Array.isArray(options) && options.length && !options.includes(value)) return false;

    const ranges = {
      brightness: [0, 255],
      brightness_pct: [0, 100],
      color_temp_kelvin: [attributes.min_color_temp_kelvin, attributes.max_color_temp_kelvin],
      humidity: [attributes.min_humidity, attributes.max_humidity],
      percentage: [0, 100],
      position: [0, 100],
      temperature: [attributes.min_temp, attributes.max_temp],
      target_temp_low: [attributes.min_temp, attributes.max_temp],
      target_temp_high: [attributes.min_temp, attributes.max_temp],
      tilt_position: [0, 100],
      value: [attributes.min, attributes.max],
      volume_level: [0, 1],
    };
    const range = ranges[name];
    if (range && typeof value === "number") {
      if (range[0] != null && value < Number(range[0])) return false;
      if (range[1] != null && value > Number(range[1])) return false;
    }
    return true;
  }

  _isActionTemplate(value) {
    return typeof value === "string"
      && /^\$(selected|value|current)(?:\s*[+-]\s*\d+(?:\.\d+)?)?$/.test(value);
  }

  async _executeService(action, data, element = null) {
    if (!this._hass) return;
    const key = `${action.domain}.${action.service}:${action.entity_id}`;
    if (this._pendingActions.has(key)) return;
    this._pendingActions.add(key);
    if (element) {
      element.disabled = true;
      element.classList.add("action-pending");
      element.setAttribute("aria-busy", "true");
    }
    let timeoutId;
    try {
      const timeout = new Promise((_, reject) => {
        timeoutId = window.setTimeout(
          () => reject(new Error("Home Assistant action timed out.")),
          this._actionTimeoutMs,
        );
      });
      await Promise.race([
        Promise.resolve(this._hass.callService(action.domain, action.service, data)),
        timeout,
      ]);
      if (element?.isConnected) {
        element.classList.remove("action-error");
        element.classList.add("action-success");
        element.title = "Action completed.";
        window.setTimeout(() => element.classList.remove("action-success"), 1200);
      }
    } catch (error) {
      if (element) {
        element.classList.add("action-error");
        element.title = error?.message || "Home Assistant rejected this action.";
      }
      this.dispatchEvent(new CustomEvent("urdash-action-error", {
        bubbles: true,
        composed: true,
        detail: { action, message: error?.message || "Action failed." },
      }));
    } finally {
      if (timeoutId) window.clearTimeout(timeoutId);
      this._pendingActions.delete(key);
      if (element?.isConnected) {
        element.disabled = !this._actionAllowed(action);
        element.classList.remove("action-pending");
        element.removeAttribute("aria-busy");
      }
    }
  }

  _resolveActionData(data, context) {
    const resolved = {};
    for (const [key, value] of Object.entries(data || {})) {
      resolved[key] = this._resolveValue(value, context);
    }
    return resolved;
  }

  _resolveValue(value, context) {
    if (this._isExpression(value)) return this._evaluateExpression(value, context);
    if (value === "$selected") return context.selected;
    if (value === "$value") return context.value;
    if (value === "$current") return context.current;
    const add = String(value).match(/^\$current\s*([+-])\s*(\d+(?:\.\d+)?)$/);
    if (add && Number.isFinite(Number(context.current))) {
      return add[1] === "+" ? Number(context.current) + Number(add[2]) : Number(context.current) - Number(add[2]);
    }
    return value;
  }

  _isExpression(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.op === "string";
  }

  _resolveDisplay(value, context = {}) {
    const resolved = this._isExpression(value) ? this._evaluateExpression(value, context) : value;
    if (resolved === null || resolved === undefined) return "";
    return String(resolved).slice(0, 1024);
  }

  _evaluateExpression(expression, context = {}, depth = 1, budget = { operations: 0 }) {
    if (!this._isExpression(expression) || depth > 8 || ++budget.operations > 128) return null;
    const metadata = this._expressionMetadataFor(expression);
    const cacheable = !metadata.volatile && !metadata.local;
    const cached = cacheable ? this._expressionCache.get(expression) : null;
    if (
      cached
      && [...metadata.entities].every((entityId) => cached.states.get(entityId) === this._hass?.states?.[entityId])
      && [...metadata.sources].every((sourceId) => cached.sources.get(sourceId) === (this._sourceVersions.get(sourceId) || 0))
    ) return cached.value;
    const evaluate = (value) => this._isExpression(value)
      ? this._evaluateExpression(value, context, depth + 1, budget)
      : value;
    const args = Array.isArray(expression.args) ? expression.args.slice(0, 16).map(evaluate) : [];
    const numbers = args.map(Number).filter(Number.isFinite);
    const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
    let result = null;
    switch (expression.op) {
      case "literal": result = expression.value; break;
      case "entity": result = this._readEntityPath(expression.entity_id, expression.path || "state"); break;
      case "source": result = this._readSourcePath(expression.source_id, expression.path); break;
      case "local": result = context[expression.name] ?? null; break;
      case "concat": result = args.map((value) => value ?? "").join(""); break;
      case "add": result = numbers.length === args.length ? numbers.reduce((sum, value) => sum + value, 0) : null; break;
      case "subtract": result = numbers.length === args.length && numbers.length ? numbers.slice(1).reduce((value, part) => value - part, numbers[0]) : null; break;
      case "multiply": result = numbers.length === args.length ? numbers.reduce((value, part) => value * part, 1) : null; break;
      case "divide": result = numbers.length === args.length && numbers.length > 1 && numbers.slice(1).every((value) => value !== 0) ? numbers.slice(1).reduce((value, part) => value / part, numbers[0]) : null; break;
      case "modulo": result = numbers.length === 2 && numbers[1] !== 0 ? numbers[0] % numbers[1] : null; break;
      case "min": result = numbers.length === args.length && numbers.length ? Math.min(...numbers) : null; break;
      case "max": result = numbers.length === args.length && numbers.length ? Math.max(...numbers) : null; break;
      case "average": result = numbers.length === args.length && numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null; break;
      case "sum": result = numbers.length === args.length ? numbers.reduce((sum, value) => sum + value, 0) : null; break;
      case "clamp": {
        const value = number(args[0]);
        result = value === null ? null : Math.min(Number(expression.max ?? value), Math.max(Number(expression.min ?? value), value));
        break;
      }
      case "round": {
        const value = number(args[0]);
        const factor = 10 ** Math.min(6, Math.max(0, Number(expression.decimals ?? 0)));
        result = value === null ? null : Math.round((value + Number.EPSILON) * factor) / factor;
        break;
      }
      case "percentage": result = numbers.length >= 2 && numbers[1] !== 0 ? (numbers[0] / numbers[1]) * 100 : null; break;
      case "eq": result = args[0] === args[1]; break;
      case "ne": result = args[0] !== args[1]; break;
      case "gt": result = args[0] > args[1]; break;
      case "gte": result = args[0] >= args[1]; break;
      case "lt": result = args[0] < args[1]; break;
      case "lte": result = args[0] <= args[1]; break;
      case "and": result = args.every(Boolean); break;
      case "or": result = args.some(Boolean); break;
      case "not": result = !args[0]; break;
      case "if": result = evaluate(expression.condition) ? evaluate(expression.then) : evaluate(expression.else); break;
      case "coalesce": result = args.find((value) => value !== null && value !== undefined && value !== "") ?? evaluate(expression.default); break;
      case "map": {
        const source = args[0];
        const match = (expression.cases || []).slice(0, 32).find((item) => item?.when === source);
        result = match ? evaluate(match.value) : evaluate(expression.default);
        break;
      }
      case "format_number": result = this._formatExpressionNumber(args[0], expression); break;
      case "format_datetime": result = this._formatExpressionDate(args[0], expression); break;
      case "format_duration": result = this._formatExpressionDuration(args[0]); break;
      case "relative_time": result = this._formatRelativeTime(args[0], expression.locale); break;
      case "convert_unit": result = this._convertUnit(args[0], expression.from_unit, expression.to_unit); break;
      default: result = null;
    }
    if (typeof result === "string") result = `${expression.prefix || ""}${result.slice(0, 1024)}${expression.suffix || ""}`.slice(0, 1024);
    if (cacheable) {
      this._expressionCache.set(expression, {
        states: new Map([...metadata.entities].map((entityId) => [entityId, this._hass?.states?.[entityId]])),
        sources: new Map([...metadata.sources].map((sourceId) => [sourceId, this._sourceVersions.get(sourceId) || 0])),
        value: result,
      });
    }
    return result;
  }

  _expressionMetadataFor(expression) {
    const cached = this._expressionMetadata.get(expression);
    if (cached) return cached;
    const metadata = { entities: new Set(), sources: new Set(), local: false, volatile: false };
    const visit = (node) => {
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (!this._isExpression(node)) {
        if (node && typeof node === "object") Object.values(node).forEach(visit);
        return;
      }
      if (node.op === "entity" && typeof node.entity_id === "string") metadata.entities.add(node.entity_id);
      if (node.op === "source" && typeof node.source_id === "string") metadata.sources.add(node.source_id);
      if (node.op === "local") metadata.local = true;
      if (node.op === "relative_time") metadata.volatile = true;
      Object.values(node).forEach(visit);
    };
    visit(expression);
    this._expressionMetadata.set(expression, metadata);
    return metadata;
  }

  _readEntityPath(entityId, path) {
    const state = this._state(entityId);
    if (!state || !this._safeDataPath(path)) return null;
    return path.split(".").reduce((value, part) => value?.[part], state) ?? null;
  }

  _readSourcePath(sourceId, path) {
    const source = this._sourceValues.get(sourceId);
    const parts = String(path || "").split(".");
    if (!source || !this._safeSourcePath(parts)) return null;
    return parts.reduce((value, part) => value?.[/^\d+$/.test(part) ? Number(part) : part], source) ?? null;
  }

  _safeSourcePath(parts) {
    if (parts.length === 1 && ["type", "status"].includes(parts[0])) return true;
    return parts.length === 3
      && parts[0] === "forecast"
      && /^\d+$/.test(parts[1])
      && Number(parts[1]) >= 0
      && Number(parts[1]) < 16
      && FORECAST_FIELDS.has(parts[2]);
  }

  _safeDataPath(path) {
    const value = String(path || "");
    if (["state", "last_changed", "last_updated"].includes(value)) return true;
    return /^attributes(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value)
      && !value.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part));
  }

  _formatExpressionNumber(value, expression) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const locale = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(expression.locale || "") ? expression.locale : undefined;
    const style = ["decimal", "percent", "currency", "unit"].includes(expression.style) ? expression.style : "decimal";
    const options = { style, maximumFractionDigits: Math.min(6, Math.max(0, Number(expression.decimals ?? 2))) };
    if (style === "currency") options.currency = /^[A-Z]{3}$/.test(expression.currency || "") ? expression.currency : "USD";
    if (style === "unit" && /^[A-Za-z0-9-]{1,24}$/.test(expression.unit || "")) options.unit = expression.unit;
    try { return new Intl.NumberFormat(locale, options).format(number); } catch { return String(number); }
  }

  _formatExpressionDate(value, expression) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const locale = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(expression.locale || "") ? expression.locale : undefined;
    const specialStyles = {
      weekday_short: { weekday: "short" },
      weekday_long: { weekday: "long" },
      time_short: { hour: "numeric", minute: "2-digit" },
    };
    const dateStyle = ["short", "medium", "long", "full"].includes(expression.style) ? expression.style : "medium";
    const options = specialStyles[expression.style] || { dateStyle, timeStyle: dateStyle === "full" ? "long" : "short" };
    try { return new Intl.DateTimeFormat(locale, options).format(date); } catch { return date.toLocaleString(); }
  }

  _formatExpressionDuration(value) {
    let seconds = Math.max(0, Math.floor(Number(value)));
    if (!Number.isFinite(seconds)) return null;
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    seconds %= 60;
    return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${seconds}s`].filter(Boolean).join(" ");
  }

  _formatRelativeTime(value, locale) {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return null;
    const seconds = Math.round((timestamp - Date.now()) / 1000);
    const [amount, unit] = Math.abs(seconds) >= 86400 ? [Math.round(seconds / 86400), "day"] : Math.abs(seconds) >= 3600 ? [Math.round(seconds / 3600), "hour"] : Math.abs(seconds) >= 60 ? [Math.round(seconds / 60), "minute"] : [seconds, "second"];
    try { return new Intl.RelativeTimeFormat(locale || undefined, { numeric: "auto" }).format(amount, unit); } catch { return `${amount} ${unit}`; }
  }

  _convertUnit(value, fromUnit, toUnit) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const key = `${String(fromUnit || "").toLowerCase()}>${String(toUnit || "").toLowerCase()}`;
    const conversions = {
      "c>f": (v) => v * 9 / 5 + 32, "°c>°f": (v) => v * 9 / 5 + 32,
      "f>c": (v) => (v - 32) * 5 / 9, "°f>°c": (v) => (v - 32) * 5 / 9,
      "w>kw": (v) => v / 1000, "kw>w": (v) => v * 1000,
      "wh>kwh": (v) => v / 1000, "kwh>wh": (v) => v * 1000,
      "m/s>km/h": (v) => v * 3.6, "km/h>m/s": (v) => v / 3.6,
      "pa>kpa": (v) => v / 1000, "kpa>pa": (v) => v * 1000,
    };
    return fromUnit === toUnit ? number : conversions[key]?.(number) ?? null;
  }

  _collectEntityDependencies(value) {
    const dependencies = new Set();
    const visit = (node, key = "") => {
      if (Array.isArray(node)) {
        node.forEach((child) => visit(child, key));
        return;
      }
      if (!node || typeof node !== "object") return;
      if (node.op === "entity" && typeof node.entity_id === "string") dependencies.add(node.entity_id);
      for (const [name, child] of Object.entries(node)) {
        if (["entity", "entity_id"].includes(name) && typeof child === "string" && child.includes(".")) dependencies.add(child);
        else if (["entities", "primary_entities"].includes(name) && Array.isArray(child)) child.filter((item) => typeof item === "string").forEach((item) => dependencies.add(item));
        visit(child, name);
      }
    };
    visit(value);
    return dependencies;
  }

  _dependenciesChanged(previous, next) {
    if (!previous || !next) return true;
    if (!this._entityDependencies.size) return previous !== next;
    return [...this._entityDependencies].some((entityId) => previous.states?.[entityId] !== next.states?.[entityId]);
  }

  _toggleActionFor(entityId, state) {
    const domain = entityId.split(".", 1)[0];
    if (!["light", "switch", "fan"].includes(domain)) return { type: "more_info", entity_id: entityId };
    return { type: "service", domain, service: "toggle", entity_id: state?.entity_id || entityId };
  }

  _isVisible(config) {
    const rule = config.visibility;
    if (!rule) return true;
    if (rule.expression) return Boolean(this._evaluateExpression(rule.expression));
    const state = this._state(rule.entity);
    if (rule.operator === "exists") return Boolean(state);
    if (!state) return false;
    if (rule.operator === "equals") return state.state === String(rule.value);
    if (rule.operator === "not_equals") return state.state !== String(rule.value);
    if (rule.operator === "in") return Array.isArray(rule.value) && rule.value.map(String).includes(state.state);
    if (rule.operator === "not_in") return Array.isArray(rule.value) && !rule.value.map(String).includes(state.state);
    return true;
  }

  _state(entityId) {
    return entityId ? this._hass?.states?.[entityId] : null;
  }

  _boundValue(state, binding) {
    if (this._isExpression(binding)) return this._evaluateExpression(binding);
    if (!state) return null;
    return this._safeDataPath(binding) ? String(binding).split(".").reduce((value, part) => value?.[part], state) ?? null : null;
  }

  _stateName(state) {
    return state?.attributes?.friendly_name || state?.entity_id || "";
  }

  _shortName(state) {
    const name = this._stateName(state);
    return name
      .replace(/\bLiving Room\b/gi, "")
      .replace(/\bHome\b/gi, "")
      .replace(/\bSensor\b/gi, "")
      .replace(/\s+/g, " ")
      .trim() || state?.entity_id || "Entity";
  }

  _formatValue(value, unit = "") {
    if (value === null || value === undefined || value === "") return "--";
    return `${this._humanize(value)}${unit || ""}`;
  }

  _humanize(value) {
    const text = String(value ?? "");
    const special = {
      partlycloudy: "Partly cloudy",
      clearnight: "Clear night",
      fan_only: "Fan only",
    };
    if (special[text]) return special[text];
    if (/^-?\d+(\.\d+)?$/.test(text)) return text;
    return text
      .replaceAll("_", " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim();
  }

  _entityLine(state, fallback) {
    const row = document.createElement("div");
    row.className = "entity-line";
    const name = document.createElement("span");
    name.textContent = this._stateName(state) || fallback || "Missing entity";
    const value = document.createElement("strong");
    value.textContent = state ? this._formatValue(state.state, state.attributes?.unit_of_measurement) : "missing";
    row.append(name, value);
    return row;
  }

  _signalTile(label, value) {
    const tile = document.createElement("div");
    tile.className = "signal-tile";
    const title = document.createElement("span");
    title.textContent = label || "Signal";
    const strong = document.createElement("strong");
    strong.textContent = this._humanize(value || "--");
    tile.append(title, strong);
    return tile;
  }

  _smallButton(label, handler) {
    const button = document.createElement("button");
    button.className = "small-button";
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => handler(button));
    return button;
  }

  _label(text) {
    const span = document.createElement("span");
    span.textContent = text;
    return span;
  }

  _resolveIconAsset(config = {}) {
    const reference = config.icon_ref;
    if (reference && typeof reference === "object") {
      const iconSet = (this._card?.assets?.icon_sets || []).slice(0, 8).find((item) => item.id === reference.set);
      if (iconSet) {
        const key = this._resolveDisplay(reference.key);
        const variant = (iconSet.variants || []).slice(0, 24).find((item) => item.key === key);
        const asset = variant || iconSet.fallback;
        if (asset?.vector_icon) return { vector_icon: asset.vector_icon };
        if (asset?.icon) return { icon: this._resolveDisplay(asset.icon) };
      }
    }
    if (config.vector_icon) return { vector_icon: config.vector_icon };
    const icon = this._resolveDisplay(config.icon);
    return icon ? { icon } : null;
  }

  _appendResolvedIcon(container, config, label, className = "", accent = "") {
    const asset = this._resolveIconAsset(config);
    if (!asset) return false;
    let element;
    if (asset.vector_icon) {
      const vector = {
        ...asset.vector_icon,
        style: {
          ...(asset.vector_icon.style || {}),
          accent: this._resolveDisplay(asset.vector_icon.style?.accent) || accent || undefined,
        },
      };
      element = this._vectorSvg(vector, label || "Reusable vector icon");
      element.classList.add("resolved-vector-icon");
    } else {
      element = this._icon(asset.icon);
    }
    if (className) element.classList.add(className);
    container.appendChild(element);
    return true;
  }

  _icon(icon) {
    const element = document.createElement("ha-icon");
    const value = typeof icon === "string" ? icon : "";
    element.setAttribute("icon", value.startsWith("mdi:") ? value : "mdi:view-dashboard");
    return element;
  }

  _empty(text) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = text;
    return empty;
  }

  _missing(entityId) {
    return this._empty(`Missing entity: ${entityId || "not configured"}`);
  }

  _applyGrid(block, grid) {
    const safe = {
      col: this._clampInt(grid?.col, 1, 16, 1),
      row: this._clampInt(grid?.row, 1, 64, 1),
      w: this._clampInt(grid?.w, 1, 16, 4),
      h: this._clampInt(grid?.h, 1, 12, 2),
    };
    block.style.gridColumn = `${safe.col} / span ${safe.w}`;
    block.style.gridRow = `${safe.row} / span ${safe.h}`;
  }

  _applyFrame(block, frame, mobileFrame) {
    const desktop = this._safeFrame(frame, { x: 0, y: 0, w: 40, h: 30 });
    const mobile = this._safeFrame(mobileFrame, desktop);
    block.style.setProperty("--frame-x", `${desktop.x}%`);
    block.style.setProperty("--frame-y", `${desktop.y}%`);
    block.style.setProperty("--frame-w", `${desktop.w}%`);
    block.style.setProperty("--frame-h", `${desktop.h}%`);
    block.style.setProperty("--mobile-frame-x", `${mobile.x}%`);
    block.style.setProperty("--mobile-frame-y", `${mobile.y}%`);
    block.style.setProperty("--mobile-frame-w", `${mobile.w}%`);
    block.style.setProperty("--mobile-frame-h", `${mobile.h}%`);
    block.style.left = "var(--frame-x)";
    block.style.top = "var(--frame-y)";
    block.style.width = "var(--frame-w)";
    block.style.height = "var(--frame-h)";
  }

  _safeFrame(frame, fallback) {
    return {
      x: this._clampNumber(frame?.x, 0, 100, fallback.x),
      y: this._clampNumber(frame?.y, 0, 100, fallback.y),
      w: this._clampNumber(frame?.w, 1, 100, fallback.w),
      h: this._clampNumber(frame?.h, 1, 100, fallback.h),
    };
  }

  _styleClasses(style = {}) {
    return [
      `tone-${this._safeEnum(this._resolveDisplay(style.tone), ["neutral", "calm", "warm", "cool", "alert", "success"], "neutral")}`,
      `emphasis-${this._safeEnum(this._resolveDisplay(style.emphasis), ["low", "normal", "high", "hero"], "normal")}`,
      `shape-${this._safeEnum(this._resolveDisplay(style.shape), ["none", "soft", "pill", "circle"], "soft")}`,
    ].join(" ");
  }

  _presentationClasses(presentation = {}) {
    return [
      `surface-${this._safeEnum(presentation.surface, ["panel", "glass", "ghost", "naked", "hero", "floating", "orb", "strip", "rail"], "panel")}`,
      `scale-${this._safeEnum(presentation.scale, ["micro", "small", "normal", "large", "xl", "full"], "normal")}`,
      `align-${this._safeEnum(presentation.align, ["start", "center", "end", "stretch"], "stretch")}`,
      `layer-${this._safeEnum(presentation.layer, ["backdrop", "base", "raised", "overlay"], "base")}`,
    ].join(" ");
  }

  _animationClasses(animation = {}) {
    if (animation.active != null && !Boolean(this._isExpression(animation.active) ? this._evaluateExpression(animation.active) : animation.active)) return "anim-none trigger-always speed-normal intensity-normal";
    const preset = this._safeEnum(animation.preset, ["none", "pulse", "breathe", "glow", "float", "shimmer", "progress", "orbit", "wave", "count_up", "state_flash", "slide_in", "fade_in"], "none");
    const trigger = this._safeEnum(animation.trigger, ["always", "on_load", "on_state_change", "state_on", "state_alert", "on_hover"], "always");
    const speed = this._safeEnum(animation.speed, ["slow", "normal", "fast"], "normal");
    const intensity = this._safeEnum(animation.intensity, ["subtle", "normal", "strong"], "normal");
    return `anim-${preset} trigger-${trigger} speed-${speed} intensity-${intensity}`;
  }

  _safeKind(kind) {
    return String(kind || "unknown").replace(/[^a-z0-9_-]/gi, "");
  }

  _safeEnum(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
  }

  _safeAccent(accent) {
    const value = String(accent || "").trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
    return "#1f8a70";
  }

  _safeAspect(value) {
    return /^\d+(\.\d+)?\/\d+(\.\d+)?$/.test(String(value || "")) ? value : "16/9";
  }

  _risk(value) {
    return this._safeEnum(value, ["low", "medium", "high"], "low");
  }

  _domainIcon(entityId) {
    const domain = String(entityId || "").split(".", 1)[0];
    return {
      light: "mdi:lightbulb",
      switch: "mdi:toggle-switch",
      fan: "mdi:fan",
      climate: "mdi:thermostat",
      cover: "mdi:window-shutter",
      lock: "mdi:lock",
      scene: "mdi:palette",
    }[domain] || "mdi:circle";
  }

  _clampInt(value, min, max, fallback) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  _clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const styles = `
  :host {
    container-type: inline-size;
    display: block;
  }
  * { box-sizing: border-box; }
  button { font: inherit; }
  h3, h4, p { margin: 0; }

  .urdash-card {
    --urdash-bg: linear-gradient(135deg, #ecf8f4, #f8f3ea 52%, #e8f0f5);
    --urdash-fg: #102b2f;
    --urdash-muted: #5b7073;
    --urdash-panel: rgba(255,255,255,0.64);
    --urdash-line: rgba(255,255,255,0.48);
    display: grid;
    gap: 18px;
    min-height: var(--urdash-min-height, auto);
    border-radius: 8px;
    padding: 20px;
    background: var(--urdash-bg);
    color: var(--urdash-fg);
    overflow: hidden;
    position: relative;
    font-family: var(--paper-font-body1_-_font-family, Inter, ui-sans-serif, system-ui, sans-serif);
  }

  .theme-quiet {
    --urdash-bg: linear-gradient(135deg, #fafaf7, #f2f5f3);
    --urdash-fg: #202728;
    --urdash-muted: #6d7675;
    --urdash-panel: rgba(255,255,255,0.36);
    --urdash-line: rgba(32,39,40,0.12);
  }

  .theme-graphite {
    --urdash-bg: linear-gradient(135deg, #172326, #283338);
    --urdash-fg: #eef7f4;
    --urdash-muted: #b8c4c5;
    --urdash-panel: rgba(255,255,255,0.1);
    --urdash-line: rgba(255,255,255,0.14);
  }

  .theme-calm { --urdash-bg: linear-gradient(135deg, #f4f7f8, #e8f0ed); }
  .theme-sunrise { --urdash-bg: linear-gradient(135deg, #fff6e8, #eaf7f2); --urdash-fg: #2a2c26; }
  .height-viewport { min-height: min(760px, 92vh); }
  .height-fixed { height: var(--urdash-card-height, 720px); overflow: auto; }

  .chrome-art {
    gap: 0;
    padding: 0;
  }

  .chrome-art.theme-graphite {
    --urdash-bg:
      radial-gradient(circle at 50% 50%, rgba(38,58,74,0.34), rgba(16,24,32,0.24) 42%, rgba(13,13,13,0.94) 82%, #000 100%);
  }

  .chrome-art.layout-canvas .block-stage {
    min-height: 100%;
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    position: relative;
    z-index: 1;
  }

  .card-header span {
    color: var(--accent, #1f8a70);
    font-size: 11px;
    font-weight: 900;
    text-transform: uppercase;
  }

  .card-header h3 {
    margin-top: 4px;
    color: var(--urdash-fg);
    font-size: 28px;
    line-height: 1.06;
  }

  .card-header p {
    margin-top: 6px;
    max-width: 680px;
    color: var(--urdash-muted);
    font-size: 13px;
  }

  .risk {
    align-self: start;
    border: 1px solid var(--urdash-line);
    border-radius: 999px;
    padding: 6px 10px;
    color: var(--urdash-muted);
    font-size: 11px;
    font-weight: 900;
    text-transform: uppercase;
  }

  .risk-high { color: #a33c33; }
  .risk-medium { color: #9a651c; }

  .block-stage {
    position: relative;
    z-index: 1;
  }

  .layout-grid .block-stage {
    display: grid;
    grid-template-columns: repeat(var(--urdash-columns, 12), minmax(0, 1fr));
    grid-auto-rows: minmax(48px, auto);
    gap: 12px;
  }

  .layout-canvas .block-stage {
    aspect-ratio: var(--urdash-aspect, 16/9);
    min-height: 360px;
    overflow: hidden;
  }

  .layout-canvas .block { position: absolute; }

  .block {
    display: grid;
    align-content: start;
    gap: 12px;
    min-width: 0;
    min-height: 0;
    border: 1px solid var(--urdash-line);
    border-radius: 8px;
    padding: 14px;
    background: var(--urdash-panel);
    backdrop-filter: blur(16px);
    box-shadow: 0 18px 42px rgba(20,36,40,0.12);
    overflow: hidden;
  }

  .block-actionable { cursor: pointer; }
  .block-actionable:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .component-tree { width: 100%; min-width: 0; --component-accent: var(--accent); }
  .component { box-sizing: border-box; min-width: 0; color: var(--urdash-fg); }
  .component-row, .component-wrap, .component-surface {
    display: flex;
    flex-direction: row;
  }
  .component-column { display: flex; flex-direction: column; }
  .component-wrap { flex-wrap: wrap; }
  .component-stack { display: grid; }
  .component-stack > .component { grid-area: 1 / 1; }
  .component-surface {
    min-height: 52px;
    border: 1px solid transparent;
    transition: background-color 180ms ease, border-color 180ms ease, transform 180ms ease;
  }
  .component-surface.component-direction-column { flex-direction: column; }
  .component-surface-soft { background: color-mix(in srgb, var(--component-accent) 10%, var(--urdash-panel)); border-color: color-mix(in srgb, var(--component-accent) 16%, transparent); }
  .component-surface-glass { background: rgba(255,255,255,0.13); border-color: rgba(255,255,255,0.28); backdrop-filter: blur(14px); }
  .component-surface-solid { background: color-mix(in srgb, var(--component-accent) 22%, var(--urdash-panel)); border-color: color-mix(in srgb, var(--component-accent) 34%, transparent); }
  .component-surface-ghost { background: transparent; border-color: color-mix(in srgb, var(--component-accent) 18%, transparent); }
  .component-shape-square { border-radius: 0; }
  .component-shape-soft { border-radius: 8px; }
  .component-shape-pill { border-radius: 999px; }
  .component-shape-circle { border-radius: 50%; aspect-ratio: 1; }
  .component-gap-none { gap: 0; }
  .component-gap-xs { gap: 4px; }
  .component-gap-sm { gap: 8px; }
  .component-gap-md { gap: 12px; }
  .component-gap-lg { gap: 18px; }
  .component-padding-none { padding: 0; }
  .component-padding-xs { padding: 4px; }
  .component-padding-sm { padding: 8px; }
  .component-padding-md { padding: 12px; }
  .component-padding-lg { padding: 18px; }
  .component-align-start { align-items: flex-start; }
  .component-align-center { align-items: center; }
  .component-align-end { align-items: flex-end; }
  .component-align-stretch { align-items: stretch; }
  .component-justify-start { justify-content: flex-start; }
  .component-justify-center { justify-content: center; }
  .component-justify-end { justify-content: flex-end; }
  .component-justify-between { justify-content: space-between; }
  .component-justify-around { justify-content: space-around; }
  .component-width-auto { width: auto; }
  .component-width-fill { width: 100%; }
  .component-width-content { width: max-content; max-width: 100%; }
  .component { flex-grow: var(--component-grow, 0); }
  .component-place-center { place-self: center; }
  .component-place-top { place-self: start center; }
  .component-place-right { place-self: center end; }
  .component-place-bottom { place-self: end center; }
  .component-place-left { place-self: center start; }
  .component-place-top_left { place-self: start; }
  .component-place-top_right { place-self: start end; }
  .component-place-bottom_left { place-self: end start; }
  .component-place-bottom_right { place-self: end; }
  .component-actionable { cursor: pointer; }
  .component-actionable:hover { transform: translateY(-1px); }
  .component-actionable:focus-visible { outline: 2px solid var(--component-accent); outline-offset: 2px; }
  .component-text { display: block; overflow-wrap: anywhere; }
  .component-emphasis-low { color: var(--urdash-muted); font-weight: 600; }
  .component-emphasis-normal { font-weight: 750; }
  .component-emphasis-high { font-weight: 900; }
  .component-tone-neutral { --component-accent: #60777b; }
  .component-tone-calm { --component-accent: #2a8f83; }
  .component-tone-warm { --component-accent: #d99a3e; }
  .component-tone-cool { --component-accent: #4f91b8; }
  .component-tone-alert { --component-accent: #c95b56; }
  .component-tone-success { --component-accent: #31956e; }
  .component-size-xs { font-size: 11px; }
  .component-size-sm { font-size: 12px; }
  .component-size-md { font-size: 14px; }
  .component-size-lg { font-size: 18px; }
  .component-size-xl { font-size: 26px; }
  .component-icon { display: inline-grid; place-items: center; flex: 0 0 auto; color: var(--component-accent); }
  .component-icon ha-icon, .component-icon .resolved-vector-icon { width: 1.7em; height: 1.7em; }
  .component-value { display: grid; gap: 2px; }
  .component-value strong { font-size: 1.25em; line-height: 1; }
  .component-value span { color: var(--urdash-muted); font-size: 11px; }
  .component-toggle {
    position: relative;
    flex: 0 0 auto;
    width: 46px;
    height: 26px;
    border: 0;
    border-radius: 999px;
    padding: 3px;
    background: color-mix(in srgb, var(--urdash-muted) 24%, transparent);
    cursor: pointer;
  }
  .component-toggle span {
    display: block;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    transition: transform 180ms ease;
  }
  .component-toggle.active { background: var(--component-accent); }
  .component-toggle.active span { transform: translateX(20px); }
  .component-toggle:disabled, .component-slider:disabled, .component-color-picker:disabled, .component-select:disabled, .component-button:disabled { cursor: not-allowed; opacity: 0.48 !important; }
  .component-slider { width: 100%; min-width: 90px; accent-color: var(--component-accent); }
  .component-color-picker {
    width: 44px;
    height: 34px;
    flex: 0 0 auto;
    border: 1px solid color-mix(in srgb, var(--component-accent) 34%, var(--urdash-line));
    border-radius: 8px;
    padding: 3px;
    background: var(--urdash-panel);
    cursor: pointer;
  }
  .component-color-picker::-webkit-color-swatch-wrapper { padding: 0; }
  .component-color-picker::-webkit-color-swatch { border: 0; border-radius: 5px; }
  .component-select {
    min-width: 120px;
    min-height: 38px;
    border: 1px solid color-mix(in srgb, var(--component-accent) 26%, var(--urdash-line));
    border-radius: 8px;
    padding: 0 34px 0 10px;
    background: var(--urdash-panel);
    color: var(--urdash-fg);
    font: inherit;
    cursor: pointer;
  }
  .component-progress { width: 100%; height: 7px; accent-color: var(--component-accent); }
  .component-divider { width: 100%; border: 0; border-top: 1px solid color-mix(in srgb, var(--component-accent) 22%, transparent); }
  .component-spacer { min-width: 8px; min-height: 8px; }

  .block-visual_map {
    align-content: stretch;
  }

  .block-visual_map .block-body {
    min-height: 0;
    height: 100%;
  }

  .block-visual_map .visual-map {
    min-height: 0;
    height: 100%;
  }

  .layer-backdrop { z-index: 0; pointer-events: none; }
  .layer-base { z-index: 1; }
  .layer-raised { z-index: 2; }
  .layer-overlay { z-index: 3; }
  .align-start { place-self: start stretch; }
  .align-center { place-self: center; }
  .align-end { place-self: end stretch; }
  .align-stretch { place-self: stretch; }
  .block-text.align-center .text { text-align: center; }
  .block-text.align-end .text { text-align: right; }

  .surface-glass {
    background: linear-gradient(135deg, rgba(255,255,255,0.56), rgba(255,255,255,0.22));
    border-color: rgba(255,255,255,0.46);
    backdrop-filter: blur(24px) saturate(1.18);
  }

  .surface-ghost, .surface-naked {
    border-color: transparent;
    background: transparent;
    box-shadow: none;
    backdrop-filter: none;
  }

  .surface-naked {
    padding: 0;
  }

  .surface-hero {
    min-height: 210px;
    align-content: center;
    background:
      radial-gradient(circle at 18% 18%, color-mix(in srgb, var(--accent) 34%, transparent), transparent 32%),
      linear-gradient(135deg, color-mix(in srgb, var(--accent) 18%, rgba(255,255,255,0.7)), rgba(255,255,255,0.32));
  }

  .surface-floating {
    border-radius: 999px;
    place-self: center;
    padding: 12px 16px;
    box-shadow: 0 20px 50px color-mix(in srgb, var(--accent) 20%, transparent);
  }

  .surface-orb {
    aspect-ratio: 1;
    border-radius: 999px;
    place-items: center;
    align-content: center;
    background:
      radial-gradient(circle at 38% 32%, rgba(255,255,255,0.82), transparent 21%),
      radial-gradient(circle, color-mix(in srgb, var(--accent) 26%, transparent), rgba(255,255,255,0.2));
  }

  .surface-strip, .surface-rail {
    min-height: 0;
    border-radius: 999px;
    padding: 10px 12px;
    align-content: center;
  }

  .surface-rail {
    border-radius: 8px;
    border-left: 4px solid var(--accent);
  }

  .scale-micro { font-size: 0.78em; }
  .scale-small { font-size: 0.88em; }
  .scale-large { font-size: 1.14em; }
  .scale-xl { font-size: 1.32em; }
  .scale-full { font-size: 1em; }

  .theme-quiet .block {
    border-left: 0;
    border-right: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    backdrop-filter: none;
  }

  .emphasis-hero {
    align-content: center;
    min-height: 150px;
  }

  .block-header {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 9px;
    align-items: start;
  }

  .block-header ha-icon {
    width: 28px;
    height: 28px;
    color: var(--accent);
  }
  .block-header .resolved-vector-icon { width: 28px; height: 28px; }

  .block-header h4 {
    color: var(--urdash-fg);
    font-size: 14px;
  }

  .block-header p, .empty, .value-readout span, .signal-tile span, .entity-line span, .climate-readout span {
    color: var(--urdash-muted);
    font-size: 12px;
  }

  .text p {
    color: var(--urdash-fg);
    font-weight: 850;
  }

  .text-headline p { font-size: 30px; line-height: 1.04; }
  .text-display p { font-size: clamp(42px, 5vw, 62px); line-height: 0.94; }
  .text-title p { font-size: 22px; }
  .text-body p { font-size: 15px; }
  .text-caption p, .text-label p { color: var(--urdash-muted); font-size: 12px; }

  .hero-value {
    display: grid;
    align-content: center;
    gap: 10px;
    max-width: 100%;
    min-width: 0;
    place-items: start;
  }

  .align-center .hero-value {
    place-items: center;
    text-align: center;
  }

  .hero-value ha-icon {
    width: 30px;
    height: 30px;
    color: var(--accent);
  }
  .hero-value .resolved-vector-icon { width: 30px; height: 30px; }

  .hero-value strong {
    color: var(--urdash-fg);
    max-width: 100%;
    display: block;
    margin-bottom: 8px;
    font-size: clamp(38px, 6vw, 74px);
    line-height: 1.05;
    overflow-wrap: anywhere;
    text-align: inherit;
  }

  .scale-xl .hero-value-short strong {
    font-size: clamp(46px, 7vw, 84px);
  }

  .hero-value-long strong {
    font-size: clamp(28px, 4.2vw, 48px);
    line-height: 1.02;
  }

  .hero-value span {
    color: var(--urdash-fg);
    font-size: 14px;
    line-height: 1.1;
    font-weight: 900;
  }

  .hero-value p {
    color: var(--urdash-muted);
    font-size: 12px;
    line-height: 1.25;
  }

  .ambient-layer {
    min-height: 100%;
    display: grid;
    place-items: center;
    position: relative;
    opacity: 0.9;
  }

  .ambient-layer::before {
    content: "";
    position: absolute;
    inset: 8%;
    border-radius: 999px;
    background:
      radial-gradient(circle, color-mix(in srgb, var(--accent) 34%, transparent), transparent 62%),
      conic-gradient(from 180deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
    filter: blur(2px);
  }

  .ambient-icon {
    display: grid;
    place-items: center;
    width: min(38vw, 220px);
    aspect-ratio: 1;
    border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
    border-radius: 999px;
    color: var(--accent);
    position: relative;
  }

  .ambient-icon ha-icon {
    width: 54px;
    height: 54px;
    opacity: 0.72;
  }
  .ambient-icon .resolved-vector-icon { width: 54px; height: 54px; opacity: 0.82; }

  .ambient-text {
    display: grid;
    gap: 3px;
    place-items: center;
    margin-top: -22px;
    position: relative;
  }

  .ambient-text strong {
    color: var(--urdash-fg);
    font-size: 15px;
  }

  .ambient-text span {
    color: var(--urdash-muted);
    font-size: 12px;
  }

  .icon-orb {
    display: grid;
    place-items: center;
    width: 96px;
    height: 96px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent);
  }

  .icon-orb ha-icon { width: 48px; height: 48px; }

  .vector-icon {
    display: grid;
    place-items: center;
    width: min(100%, 180px);
    aspect-ratio: 1;
    border-radius: 999px;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    filter: drop-shadow(0 18px 34px color-mix(in srgb, var(--accent) 18%, transparent));
  }

  .surface-naked .vector-icon, .surface-ghost .vector-icon {
    background: transparent;
  }

  .scale-large .vector-icon { width: min(100%, 230px); }
  .scale-xl .vector-icon { width: min(100%, 320px); }
  .scale-full {
    align-content: stretch;
  }

  .scale-full .block-body {
    display: grid;
    min-height: 0;
    height: 100%;
  }

  .scale-full .vector-icon {
    width: 100%;
    height: 100%;
    min-height: 0;
  }

  .layout-canvas .block-vector_icon.scale-full {
    padding: 0;
    overflow: visible;
  }

  .layout-canvas .block-vector_icon.scale-full > .block-body {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    min-height: 0;
  }

  .layout-canvas .block-vector_icon.scale-full > .block-body > .vector-icon {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    aspect-ratio: auto;
  }

  .vector-icon svg {
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .vector-animated {
    transform-box: fill-box;
    transform-origin: center;
    animation-duration: var(--vector-duration, 2.4s);
    animation-delay: var(--vector-delay, 0s);
    animation-iteration-count: infinite;
    animation-timing-function: ease-in-out;
  }

  .vector-anim-pulse, .vector-anim-breathe {
    animation-name: urdash-vector-pulse;
  }

  .vector-anim-spin, .vector-anim-orbit {
    animation-name: urdash-vector-spin;
    animation-timing-function: linear;
  }

  .vector-anim-rain_drop {
    animation-name: urdash-vector-rain;
  }

  .vector-anim-drift {
    animation-name: urdash-vector-drift;
  }

  .vector-anim-dash_flow {
    stroke-dasharray: var(--vector-dash-array, 18 82);
    animation-name: urdash-vector-dash-flow;
    animation-timing-function: linear;
  }

  .vector-anim-draw {
    stroke-dasharray: 100;
    animation-name: urdash-vector-draw;
  }

  .vector-anim-twinkle {
    animation-name: urdash-vector-twinkle;
  }

  .vector-anim-fade {
    animation-name: urdash-vector-fade;
  }

  .vector-anim-shimmer {
    animation-name: urdash-vector-shimmer;
  }

  .value-readout {
    display: grid;
    gap: 4px;
  }

  .value-readout strong {
    color: var(--urdash-fg);
    font-size: 42px;
    line-height: 1;
  }

  .value-cluster, .security-cluster {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 8px;
  }

  .signal-tile {
    display: grid;
    gap: 4px;
    border: 1px solid var(--urdash-line);
    border-radius: 8px;
    padding: 10px;
    background: rgba(255,255,255,0.34);
  }

  .signal-tile strong {
    color: var(--urdash-fg);
    font-size: 18px;
    overflow-wrap: anywhere;
  }

  .entity-list, .timeline {
    display: grid;
    gap: 8px;
  }

  .entity-line {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    border-bottom: 1px solid var(--urdash-line);
    padding-bottom: 8px;
  }

  .entity-line strong {
    color: var(--urdash-fg);
    white-space: nowrap;
  }

  .action-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(116px, 1fr));
    gap: 8px;
  }

  .action-button, .segmented-control button, .small-button {
    min-height: 38px;
    border: 1px solid var(--urdash-line);
    border-radius: 8px;
    background: rgba(255,255,255,0.54);
    color: var(--urdash-fg);
    cursor: pointer;
    font-weight: 850;
  }

  .action-button {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 8px;
    align-items: center;
    padding: 10px;
    text-align: left;
  }

  .action-button:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .action-pending {
    cursor: progress !important;
    opacity: 0.72 !important;
  }

  .action-error {
    outline: 2px solid rgba(180, 52, 48, 0.72);
    outline-offset: 2px;
  }

  .action-success {
    outline: 2px solid rgba(31, 138, 112, 0.62);
    outline-offset: 2px;
  }

  .action-button ha-icon {
    width: 20px;
    height: 20px;
    color: var(--accent);
  }
  .action-button .resolved-vector-icon { width: 20px; height: 20px; }
  .chip-group .resolved-vector-icon { width: 16px; height: 16px; }
  .icon-orb .resolved-vector-icon { width: 48px; height: 48px; }

  .segmented-control {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
  }

  .segmented-control button {
    padding: 0 12px;
  }

  .segmented-control button.active {
    background: var(--accent);
    color: #fff;
  }

  .slider {
    width: 100%;
    accent-color: var(--accent);
  }

  .climate-control {
    display: grid;
    gap: 12px;
  }

  .climate-readout strong {
    display: block;
    color: var(--urdash-fg);
    font-size: 44px;
    line-height: 1;
  }

  .climate-target {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
  }

  .climate-target span {
    color: var(--urdash-fg);
    font-weight: 850;
    text-align: center;
  }

  .small-button {
    width: 36px;
    padding: 0;
  }

  .gauge-meter {
    display: grid;
    gap: 8px;
  }

  .gauge-meter::before, .sparkline-line {
    content: "";
    display: block;
    height: 8px;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--accent) var(--pct, 0%), rgba(255,255,255,0.4) 0);
  }

  .gauge-meter strong, .radial-meter strong {
    color: var(--urdash-fg);
    font-size: 34px;
    line-height: 1;
  }

  .radial-meter {
    display: grid;
    place-items: center;
    gap: 6px;
    min-height: 150px;
    border-radius: 999px;
    background: conic-gradient(var(--accent) var(--pct, 0%), rgba(255,255,255,0.32) 0);
  }

  .timeline-row {
    display: grid;
    grid-template-columns: 12px minmax(0, 1fr);
    gap: 9px;
    align-items: start;
  }

  .timeline-row span {
    width: 10px;
    height: 10px;
    margin-top: 4px;
    border-radius: 999px;
    background: var(--accent);
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 18%, transparent);
  }

  .timeline-row p {
    color: var(--urdash-fg);
    font-size: 12px;
  }

  .chip-group {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .chip-group span {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    border: 1px solid var(--urdash-line);
    border-radius: 999px;
    padding: 7px 10px;
    color: var(--urdash-fg);
    background: rgba(255,255,255,0.36);
    font-size: 12px;
    font-weight: 800;
  }

  .chip-group ha-icon {
    width: 16px;
    height: 16px;
    color: var(--accent);
  }

  .entity-orbit {
    min-height: 240px;
    position: relative;
  }

  .orbit-core {
    position: absolute;
    inset: 50% auto auto 50%;
    display: grid;
    place-items: center;
    width: min(46%, 170px);
    aspect-ratio: 1;
    border: 1px solid color-mix(in srgb, var(--accent) 38%, white);
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 16%, rgba(255,255,255,0.68));
    transform: translate(-50%, -50%);
    text-align: center;
  }

  .orbit-core strong {
    color: var(--urdash-fg);
    font-size: 28px;
    line-height: 1;
  }

  .orbit-core span {
    max-width: 120px;
    color: var(--urdash-muted);
    font-size: 11px;
    font-weight: 850;
  }

  .orbit-satellite {
    position: absolute;
    max-width: min(150px, 44%);
    border: 1px solid var(--urdash-line);
    border-radius: 999px;
    padding: 7px 10px;
    background: rgba(255,255,255,0.62);
    color: var(--urdash-fg);
    cursor: pointer;
    font-size: 10px;
    font-weight: 850;
    overflow: hidden;
    text-overflow: ellipsis;
    transform: translate(-50%, -50%);
    white-space: nowrap;
  }

  .constellation {
    min-height: 220px;
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    grid-auto-rows: 42px;
    gap: 8px;
    align-content: center;
    position: relative;
  }

  .constellation > strong {
    grid-column: 1 / -1;
    color: var(--urdash-fg);
    font-size: 15px;
  }

  .constellation-node {
    grid-column: span 2;
    display: inline-flex;
    gap: 7px;
    align-items: center;
    border: 1px solid var(--urdash-line);
    border-radius: 999px;
    padding: 8px 10px;
    background: rgba(255,255,255,0.38);
    color: var(--urdash-fg);
    cursor: pointer;
    font-size: 11px;
    font-weight: 850;
    overflow: hidden;
    min-width: 0;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .constellation-node ha-icon {
    flex: 0 0 auto;
  }

  .constellation-node:nth-child(3n) { grid-column: span 3; }
  .constellation-node:nth-child(4n) { transform: translateY(12px); }
  .constellation-node ha-icon { color: var(--accent); }

  .radial-scene {
    min-height: 260px;
    position: relative;
  }

  .radial-scene-center {
    position: absolute;
    inset: 50% auto auto 50%;
    display: grid;
    place-items: center;
    width: 132px;
    aspect-ratio: 1;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 18%, rgba(255,255,255,0.72));
    transform: translate(-50%, -50%);
    text-align: center;
  }

  .radial-scene-center ha-icon {
    width: 28px;
    height: 28px;
    color: var(--accent);
  }

  .radial-scene-center strong {
    color: var(--urdash-fg);
    font-size: 15px;
  }

  .radial-scene-center span {
    color: var(--urdash-muted);
    font-size: 10px;
    font-weight: 800;
  }

  .radial-scene-action {
    position: absolute;
    min-width: 104px;
    transform: translate(-50%, -50%);
  }

  .visual-map {
    position: relative;
    min-height: 280px;
    height: 100%;
    overflow: hidden;
  }

  .visual-map-links {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }

  .visual-link {
    fill: none;
    stroke: var(--link-accent, var(--accent));
    stroke-width: var(--link-width, 3px);
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.72;
    filter: drop-shadow(0 0 10px color-mix(in srgb, var(--link-accent, var(--accent)) 36%, transparent));
  }

  .visual-link-animated {
    stroke-dasharray: 9 11;
    animation: urdash-flow 1.6s linear infinite;
  }

  .visual-flow-tracer {
    fill: none;
    stroke: var(--link-accent, var(--accent));
    stroke-width: var(--flow-width, 2px);
    stroke-linecap: round;
    stroke-dasharray: 8 92;
    stroke-dashoffset: 100;
    filter: drop-shadow(0 0 9px color-mix(in srgb, var(--link-accent, var(--accent)) 78%, transparent));
    opacity: 0;
    pointer-events: none;
    animation: urdash-flow-tracer 2.55s linear infinite;
    animation-delay: var(--flow-delay, 0s);
  }

  .visual-flow-dot {
    fill: var(--link-accent, var(--accent));
    filter: drop-shadow(0 0 8px color-mix(in srgb, var(--link-accent, var(--accent)) 72%, transparent));
    pointer-events: none;
  }

  .visual-link-label {
    position: absolute;
    z-index: 2;
    max-width: 160px;
    transform: translate(-50%, -50%);
    border: 1px solid color-mix(in srgb, var(--link-accent, var(--accent)) 26%, var(--urdash-line));
    border-radius: 999px;
    padding: 5px 8px;
    background: color-mix(in srgb, var(--urdash-panel) 82%, rgba(255,255,255,0.76));
    color: var(--urdash-fg);
    font-size: 10px;
    font-weight: 900;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
  }

  .visual-node {
    position: absolute;
    z-index: 3;
    display: grid;
    place-items: center;
    gap: 4px;
    min-width: 84px;
    min-height: 72px;
    border: 1px solid color-mix(in srgb, var(--node-accent, var(--accent)) 36%, var(--urdash-line));
    border-radius: 8px;
    padding: 10px;
    background:
      radial-gradient(circle at 34% 24%, rgba(255,255,255,0.74), transparent 26%),
      color-mix(in srgb, var(--node-accent, var(--accent)) 14%, var(--urdash-panel));
    color: var(--urdash-fg);
    box-shadow: 0 18px 44px color-mix(in srgb, var(--node-accent, var(--accent)) 20%, transparent);
    text-align: center;
    transform: translate(-50%, -50%);
  }

  button.visual-node {
    cursor: pointer;
    font: inherit;
  }

  .visual-node ha-icon {
    width: 22px;
    height: 22px;
    color: var(--node-accent, var(--accent));
  }

  .visual-node-vector-icon {
    width: 26px;
    height: 26px;
    color: var(--node-accent, var(--accent));
    overflow: visible;
  }
  .visual-node-micro .visual-node-vector-icon { width: 18px; height: 18px; }
  .visual-node-small .visual-node-vector-icon { width: 22px; height: 22px; }
  .visual-node-large .visual-node-vector-icon { width: 30px; height: 30px; }
  .visual-node-hero .visual-node-vector-icon { width: 38px; height: 38px; }

  .visual-node strong {
    max-width: 150px;
    color: var(--urdash-fg);
    font-size: 20px;
    line-height: 1;
    overflow-wrap: anywhere;
  }

  .visual-node span {
    max-width: 150px;
    color: var(--urdash-muted);
    font-size: 11px;
    font-weight: 900;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .visual-node-stats {
    display: grid;
    gap: 2px;
    margin-top: 2px;
  }

  .visual-node-stats small {
    color: var(--urdash-muted);
    font-size: 10px;
    font-weight: 900;
    line-height: 1;
    white-space: nowrap;
  }

  .visual-node-stats .visual-stat-positive {
    color: #25a55f;
  }

  .visual-node-stats .visual-stat-negative {
    color: #c06c5a;
  }

  .visual-node-stats .visual-stat-muted {
    color: var(--urdash-muted);
  }

  .visual-node-micro { min-width: 58px; min-height: 50px; padding: 7px; }
  .visual-node-small { min-width: 72px; min-height: 62px; }
  .visual-node-large { min-width: 112px; min-height: 96px; }
  .visual-node-hero { min-width: 148px; min-height: 128px; }
  .visual-node-hero strong { font-size: 34px; }
  .visual-node-circle, .visual-node-orb, .visual-node-core, .visual-node-ring { border-radius: 999px; aspect-ratio: 1; }
  .visual-node-pill { border-radius: 999px; min-height: 54px; grid-template-columns: auto minmax(0, 1fr); text-align: left; }
  .visual-node-ring {
    border-width: 3px;
    background:
      radial-gradient(circle at center, rgba(255,255,255,0.08) 0 48%, transparent 49%),
      color-mix(in srgb, var(--node-accent, var(--accent)) 8%, rgba(255,255,255,0.1));
  }
  .visual-ring-thin { border-width: 2px; }
  .visual-ring-thick { border-width: 5px; }
  .visual-node-core {
    background:
      radial-gradient(circle, color-mix(in srgb, var(--node-accent, var(--accent)) 24%, rgba(255,255,255,0.84)), rgba(255,255,255,0.22));
  }

  hr {
    width: 100%;
    border: 0;
    border-top: 1px solid var(--urdash-line);
  }

  .anim-breathe, .anim-pulse { animation: urdash-breathe 2.8s ease-in-out infinite; }
  .anim-glow { animation: urdash-glow 2.4s ease-in-out infinite alternate; }
  .anim-float { animation: urdash-float 3s ease-in-out infinite; }
  .anim-slide_in { animation: urdash-slide 0.45s ease-out both; }
  .anim-fade_in { animation: urdash-fade 0.5s ease-out both; }

  @keyframes urdash-breathe {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.015); }
  }

  @keyframes urdash-glow {
    from { box-shadow: 0 18px 42px rgba(20,36,40,0.12); }
    to { box-shadow: 0 18px 54px color-mix(in srgb, var(--accent) 26%, transparent); }
  }

  @keyframes urdash-float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-4px); }
  }

  @keyframes urdash-slide {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes urdash-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes urdash-flow {
    from { stroke-dashoffset: 40; }
    to { stroke-dashoffset: 0; }
  }

  @keyframes urdash-flow-tracer {
    0% {
      opacity: 0;
      stroke-dashoffset: 100;
    }
    8% {
      opacity: 0.96;
    }
    88% {
      opacity: 0.96;
    }
    100% {
      opacity: 0;
      stroke-dashoffset: 0;
    }
  }

  @keyframes urdash-vector-pulse {
    0%, 100% { transform: scale(1); opacity: 0.82; }
    50% { transform: scale(calc(1 + 0.08 * var(--vector-strength, 1))); opacity: 1; }
  }

  @keyframes urdash-vector-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  @keyframes urdash-vector-rain {
    0% { opacity: 0; transform: translateY(calc(-5px * var(--vector-strength, 1))); }
    20% { opacity: 1; }
    82% { opacity: 1; }
    100% { opacity: 0; transform: translateY(calc(8px * var(--vector-strength, 1))); }
  }

  @keyframes urdash-vector-drift {
    0%, 100% { transform: translateX(calc(-2px * var(--vector-strength, 1))); }
    50% { transform: translateX(calc(4px * var(--vector-strength, 1))); }
  }

  @keyframes urdash-vector-dash-flow {
    from { stroke-dashoffset: 100; }
    to { stroke-dashoffset: 0; }
  }

  @keyframes urdash-vector-draw {
    0% { stroke-dashoffset: 100; opacity: 0.2; }
    45% { opacity: 1; }
    70%, 100% { stroke-dashoffset: 0; opacity: 1; }
  }

  @keyframes urdash-vector-twinkle {
    0%, 100% { opacity: 0.38; transform: scale(0.92); }
    50% { opacity: 1; transform: scale(calc(1 + 0.12 * var(--vector-strength, 1))); }
  }

  @keyframes urdash-vector-fade {
    0%, 100% { opacity: 0.32; }
    50% { opacity: 1; }
  }

  @keyframes urdash-vector-shimmer {
    0%, 100% { opacity: 0.42; transform: translateX(calc(-2px * var(--vector-strength, 1))) scale(0.98); }
    50% { opacity: 1; transform: translateX(calc(3px * var(--vector-strength, 1))) scale(1.02); }
  }


  @media (max-width: 680px) {
    .urdash-card { padding: 14px; }
    .card-header { display: grid; }
    .layout-grid .block-stage { grid-template-columns: 1fr; }
    .layout-grid .block { grid-column: auto !important; grid-row: auto !important; }
  }

  @container (max-width: 520px) {
    .urdash-card {
      gap: 12px;
      padding: 12px;
    }

    .height-viewport {
      min-height: min(680px, 142cqw);
    }

    .card-header {
      display: grid;
      gap: 8px;
    }

    .card-header h3 {
      font-size: clamp(20px, 7cqw, 24px);
      line-height: 1.08;
    }

    .card-header p {
      font-size: 12px;
      line-height: 1.35;
    }

    .risk {
      justify-self: start;
      padding: 4px 8px;
      font-size: 10px;
    }

    .layout-canvas .block-stage {
      aspect-ratio: var(--urdash-mobile-aspect, 4/5);
      min-height: min(640px, 132cqw);
    }

    .layout-canvas .block {
      left: var(--mobile-frame-x, var(--frame-x)) !important;
      top: var(--mobile-frame-y, var(--frame-y)) !important;
      width: var(--mobile-frame-w, var(--frame-w)) !important;
      height: var(--mobile-frame-h, var(--frame-h)) !important;
    }

    .block {
      gap: 8px;
      padding: 10px;
      box-shadow: 0 12px 28px rgba(20,36,40,0.1);
    }

    .block.surface-naked {
      padding: 0;
      box-shadow: none;
    }

    .visual-link {
      stroke-width: calc(var(--link-width, 3px) * 0.82);
    }

    .visual-flow-tracer {
      stroke-width: calc(var(--flow-width, 2px) * 0.82);
    }

    .vector-icon {
      width: min(100%, 150px);
    }

    .scale-large .vector-icon { width: min(100%, 180px); }
    .scale-xl .vector-icon { width: min(100%, 220px); }
    .scale-full .vector-icon {
      width: 100%;
      height: 100%;
    }

    .visual-node {
      gap: 2px;
      min-width: 66px;
      min-height: 58px;
      padding: 7px;
      box-shadow: 0 12px 30px color-mix(in srgb, var(--node-accent, var(--accent)) 18%, transparent);
    }

    .visual-node ha-icon {
      width: 18px;
      height: 18px;
    }

    .visual-node-vector-icon {
      width: 19px;
      height: 19px;
    }
    .visual-node-micro .visual-node-vector-icon { width: 14px; height: 14px; }
    .visual-node-small .visual-node-vector-icon { width: 16px; height: 16px; }
    .visual-node-large .visual-node-vector-icon { width: 22px; height: 22px; }
    .visual-node-hero .visual-node-vector-icon { width: 28px; height: 28px; }

    .visual-node strong {
      max-width: 104px;
      font-size: 16px;
    }

    .visual-node span {
      max-width: 104px;
      font-size: 9px;
    }

    .visual-node-stats {
      gap: 1px;
      margin-top: 0;
    }

    .visual-node-stats small {
      font-size: 8px;
    }

    .visual-node-micro { min-width: 46px; min-height: 42px; padding: 5px; }
    .visual-node-small { min-width: 58px; min-height: 52px; }
    .visual-node-large { min-width: 88px; min-height: 78px; }
    .visual-node-hero { min-width: 108px; min-height: 96px; }
    .visual-node-hero strong { font-size: 24px; }
    .visual-node-ring { border-width: 2px; }
    .visual-ring-thin { border-width: 1px; }
    .visual-ring-thick { border-width: 4px; }
  }

  @container (max-width: 360px) {
    .urdash-card {
      padding: 10px;
    }

    .card-header h3 {
      font-size: 19px;
    }

    .layout-canvas .block-stage {
      min-height: min(600px, 138cqw);
    }

    .visual-node {
      min-width: 58px;
      min-height: 52px;
      padding: 6px;
    }

    .visual-node strong {
      font-size: 14px;
    }

    .visual-node span {
      font-size: 8px;
    }

    .visual-node-stats small {
      font-size: 7px;
    }

    .visual-node-large { min-width: 78px; min-height: 70px; }
    .visual-node-hero { min-width: 96px; min-height: 86px; }
    .visual-node-hero strong { font-size: 21px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .block,
    .vector-icon,
    .vector-icon * {
      animation: none !important;
      transition: none !important;
    }
  }
`;

if (!customElements.get("urdash-card")) {
  customElements.define("urdash-card", UrDashCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "urdash-card",
  name: "UrDash Card",
  description: "Renders safe AI-generated UrDash v2 custom card specs.",
});
