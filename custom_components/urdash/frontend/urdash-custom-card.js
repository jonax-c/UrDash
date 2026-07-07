class UrDashCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._card = null;
  }

  setConfig(config) {
    this._config = this._normalizeConfig(config || {});
    this._card = this._config.card;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    const blocks = this._card?.layout?.blocks || [];
    return Math.max(3, Math.min(12, Math.ceil(blocks.length / 2) + 2));
  }

  _normalizeConfig(config) {
    if (config.urdash_schema !== 2) throw new Error("UrDash card requires urdash_schema: 2.");
    if (!config.card?.layout?.blocks) throw new Error("UrDash v2 card requires card.layout.blocks.");
    return config;
  }

  _render() {
    if (!this.shadowRoot || !this._card) return;
    const layout = this._card.layout || {};
    const intent = this._card.intent || {};
    const heightMode = this._safeEnum(this._config.height_mode, ["auto", "viewport", "fixed"], "auto");
    const theme = this._safeEnum(layout.theme, ["aurora", "quiet", "graphite", "calm", "sunrise"], "aurora");
    const density = this._safeEnum(layout.density, ["compact", "comfortable", "spacious"], "comfortable");
    const type = this._safeEnum(layout.type, ["grid", "canvas"], "grid");

    this.shadowRoot.innerHTML = `
      <style>${styles}</style>
      <article class="urdash-card theme-${theme} density-${density} height-${heightMode} layout-${type}">
        <header class="card-header">
          <div>
            <span>${escapeHtml(intent.goal || "urdash")}</span>
            <h3>${escapeHtml(intent.title || "UrDash Card")}</h3>
            <p>${escapeHtml(intent.summary || "")}</p>
          </div>
          <div class="risk risk-${this._risk(intent.risk_level)}">${escapeHtml(intent.risk_level || "low")}</div>
        </header>
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
    block.style.setProperty("--accent", this._safeAccent(config.style?.accent));

    if (layoutType === "grid") this._applyGrid(block, config.grid);
    else this._applyFrame(block, config.frame);

    if (this._shouldRenderHeader(config)) {
      block.appendChild(this._createBlockHeader(config));
    }

    const body = document.createElement("div");
    body.className = "block-body";
    body.appendChild(this._createBlockBody(config));
    block.appendChild(body);
    return block;
  }

  _createBlockHeader(config) {
    const header = document.createElement("div");
    header.className = "block-header";
    if (config.icon) header.appendChild(this._icon(config.icon));
    const text = document.createElement("div");
    if (config.title) {
      const title = document.createElement("h4");
      title.textContent = config.title;
      text.appendChild(title);
    }
    if (config.subtitle) {
      const subtitle = document.createElement("p");
      subtitle.textContent = config.subtitle;
      text.appendChild(subtitle);
    }
    header.appendChild(text);
    return header;
  }

  _shouldRenderHeader(config) {
    if (!(config.title || config.subtitle || config.icon)) return false;
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
      default:
        return this._empty(`Unsupported block: ${config.kind || "unknown"}`);
    }
  }

  _textBlock(config) {
    const wrap = document.createElement("div");
    wrap.className = `text text-${this._safeEnum(config.variant, ["label", "body", "headline", "title", "caption"], "body")}`;
    const text = document.createElement("p");
    text.textContent = config.text || config.title || "";
    wrap.appendChild(text);
    return wrap;
  }

  _iconBlock(config) {
    const wrap = document.createElement("div");
    wrap.className = "icon-orb";
    wrap.appendChild(this._icon(config.icon || "mdi:view-dashboard"));
    return wrap;
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
    label.textContent = config.label || this._stateName(state) || config.entity || "Value";
    wrap.append(strong, label);
    return wrap;
  }

  _valueCluster(config) {
    const grid = document.createElement("div");
    grid.className = "value-cluster";
    for (const item of (config.items || []).slice(0, 12)) {
      const state = this._state(item.entity);
      grid.appendChild(this._signalTile(item.label, this._formatValue(this._boundValue(state, item.value || "state"), item.unit || state?.attributes?.unit_of_measurement)));
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
    return this._actionButton(config.label || config.title || "Action", config.icon, config.action);
  }

  _buttonGroup(buttons) {
    const group = document.createElement("div");
    group.className = "action-grid";
    for (const button of buttons.slice(0, 8)) group.appendChild(this._actionButton(button.label, button.icon, button.action));
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
      button.addEventListener("click", () => this._runAction(config.action, { selected: option.value, current: state?.state }));
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
    input.addEventListener("change", () => this._runAction(config.action, { value: Number(input.value), current: Number(state?.state) }));
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
      this._smallButton("-", () => this._callService("climate", "set_temperature", { entity_id: entityId, temperature: Number(target) - 1 })),
      this._label(`Target ${target}${unit}`),
      this._smallButton("+", () => this._callService("climate", "set_temperature", { entity_id: entityId, temperature: Number(target) + 1 })),
    );
    const modes = document.createElement("div");
    modes.className = "segmented-control";
    for (const mode of (state.attributes?.hvac_modes || []).slice(0, 6)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = mode === state.state ? "active" : "";
      button.textContent = this._humanize(mode);
      button.addEventListener("click", () => this._callService("climate", "set_hvac_mode", { entity_id: entityId, hvac_mode: mode }));
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
      if (chip.icon) span.appendChild(this._icon(chip.icon));
      span.append(document.createTextNode(`${chip.label}${state ? ` · ${this._humanize(state.state)}` : ""}`));
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
    if (config.icon) wrap.appendChild(this._icon(config.icon));
    const valueEl = document.createElement("strong");
    valueEl.textContent = this._formatValue(value, unit);
    const label = document.createElement("span");
    label.textContent = config.label || config.title || this._stateName(state) || config.entity || "Status";
    const subtitle = document.createElement("p");
    subtitle.textContent = config.subtitle || this._humanize(state?.state || "");
    wrap.append(valueEl, label, subtitle);
    return wrap;
  }

  _ambient(config) {
    const wrap = document.createElement("div");
    wrap.className = "ambient-layer";
    const icon = document.createElement("div");
    icon.className = "ambient-icon";
    icon.appendChild(this._icon(config.icon || "mdi:creation"));
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
    if (config.icon) center.appendChild(this._icon(config.icon));
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
      });
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
      const state = this._state(link.entity);
      const value = Number(this._boundValue(state, link.bind?.value || "state"));
      const active = Number.isFinite(value) ? Math.abs(value) > 0 : Boolean(state);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", `visual-link ${link.style?.animated && active ? "visual-link-animated" : ""}`);
      path.setAttribute("d", this._visualMapPath(from, to, link.style?.curve));
      path.setAttribute("pathLength", "100");
      path.style.setProperty("--link-accent", this._safeAccent(link.style?.accent || config.style?.accent));
      path.style.setProperty("--link-width", `${this._visualLinkWidth(link, value)}px`);
      const markerId = this._visualMarker(defs, config.id, index, link.style?.accent || config.style?.accent);
      if (link.style?.direction === "reverse") path.setAttribute("marker-start", `url(#${markerId})`);
      else if (link.style?.direction !== "none") path.setAttribute("marker-end", `url(#${markerId})`);
      svg.appendChild(path);

      const label = document.createElement("span");
      label.className = "visual-link-label";
      label.style.left = `${(from.x + to.x) / 2}%`;
      label.style.top = `${(from.y + to.y) / 2}%`;
      label.style.setProperty("--link-accent", this._safeAccent(link.style?.accent || config.style?.accent));
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
        `visual-node-${this._safeEnum(node.style?.shape, ["none", "soft", "pill", "circle", "orb", "core"], "soft")}`,
      ].join(" ");
      element.style.left = `${node.x}%`;
      element.style.top = `${node.y}%`;
      element.style.setProperty("--node-accent", this._safeAccent(node.style?.accent || config.style?.accent));
      if (element.tagName === "BUTTON") {
        element.type = "button";
        element.addEventListener("click", () => this._runAction(node.action || { type: "more_info", entity_id: node.entity }));
      }
      if (node.icon) element.appendChild(this._icon(node.icon));
      const value = document.createElement("strong");
      value.textContent = this._formatValue(
        this._boundValue(state, node.bind?.value || "state"),
        this._boundValue(state, node.bind?.unit || "attributes.unit_of_measurement"),
      );
      const label = document.createElement("span");
      label.textContent = node.label || this._shortName(state) || node.id;
      element.append(value, label);
      wrap.appendChild(element);
    }

    if (!nodes.length) wrap.appendChild(this._empty("No visual map nodes configured."));
    return wrap;
  }

  _visualMapPath(from, to, curve = "soft") {
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
    if (typeof link.style?.width === "number") return this._clampNumber(link.style.width, 1, 10, 3);
    if (link.style?.width !== "dynamic" || !Number.isFinite(value)) return 3;
    return Math.max(2, Math.min(9, 2 + Math.sqrt(Math.abs(value)) / 8));
  }

  _visualLinkLabel(link, state) {
    if (link.label && !state) return link.label;
    if (!state) return link.label || "";
    const value = this._formatValue(
      this._boundValue(state, link.bind?.value || "state"),
      this._boundValue(state, link.bind?.unit || "attributes.unit_of_measurement"),
    );
    return link.label ? `${link.label} ${value}` : value;
  }

  _actionButton(label, icon, action) {
    const button = document.createElement("button");
    button.className = "action-button";
    button.type = "button";
    if (icon) button.appendChild(this._icon(icon));
    const text = document.createElement("span");
    text.textContent = label || "Action";
    button.appendChild(text);
    button.disabled = !this._actionAllowed(action);
    button.addEventListener("click", () => this._runAction(action));
    return button;
  }

  _runAction(action, context = {}) {
    if (!this._actionAllowed(action)) return;
    if (this._requiresConfirmation(action) && !window.confirm(action.confirmation?.text || "Run this action?")) return;
    if (action.type === "more_info") {
      this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: action.entity_id } }));
      return;
    }
    if (action.type === "navigate" && action.navigation_path?.startsWith("/")) {
      history.pushState(null, "", action.navigation_path);
      window.dispatchEvent(new CustomEvent("location-changed"));
      return;
    }
    if (action.type !== "service") return;
    const data = this._resolveActionData(action.data || {}, context);
    this._callService(action.domain, action.service, { ...data, entity_id: action.entity_id });
  }

  _callService(domain, service, data) {
    if (!this._hass || !this._serviceAllowed(domain, service)) return;
    this._hass.callService(domain, service, data);
  }

  _actionAllowed(action) {
    if (!action || action.type === "none") return false;
    if (action.type === "more_info") return Boolean(action.entity_id);
    if (action.type === "navigate") return String(action.navigation_path || "").startsWith("/");
    return action.type === "service" && this._serviceAllowed(action.domain, action.service) && Boolean(action.entity_id);
  }

  _serviceAllowed(domain, service) {
    const allow = {
      light: ["turn_on", "turn_off", "toggle"],
      switch: ["turn_on", "turn_off", "toggle"],
      fan: ["turn_on", "turn_off", "toggle"],
      climate: ["set_temperature", "set_hvac_mode"],
      cover: ["open_cover", "close_cover", "stop_cover"],
      lock: ["lock", "unlock"],
      scene: ["turn_on"],
      script: ["turn_on"],
      media_player: ["media_play_pause", "volume_set"],
    };
    return allow[domain]?.includes(service);
  }

  _requiresConfirmation(action) {
    return action?.confirmation?.required || (action?.domain === "lock" && action?.service === "unlock");
  }

  _resolveActionData(data, context) {
    const resolved = {};
    for (const [key, value] of Object.entries(data || {})) {
      resolved[key] = this._resolveValue(value, context);
    }
    return resolved;
  }

  _resolveValue(value, context) {
    if (value === "$selected") return context.selected;
    if (value === "$value") return context.value;
    if (value === "$current") return context.current;
    const add = String(value).match(/^\$current\s*([+-])\s*(\d+(?:\.\d+)?)$/);
    if (add && Number.isFinite(Number(context.current))) {
      return add[1] === "+" ? Number(context.current) + Number(add[2]) : Number(context.current) - Number(add[2]);
    }
    return value;
  }

  _toggleActionFor(entityId, state) {
    const domain = entityId.split(".", 1)[0];
    if (!["light", "switch", "fan"].includes(domain)) return { type: "more_info", entity_id: entityId };
    return { type: "service", domain, service: "toggle", entity_id: state?.entity_id || entityId };
  }

  _isVisible(config) {
    const rule = config.visibility;
    if (!rule) return true;
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
    if (!state) return null;
    if (binding === "state") return state.state;
    if (binding === "last_changed") return state.last_changed;
    if (binding === "last_updated") return state.last_updated;
    if (String(binding || "").startsWith("attributes.")) return state.attributes?.[String(binding).slice(11)];
    return null;
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
    button.addEventListener("click", handler);
    return button;
  }

  _label(text) {
    const span = document.createElement("span");
    span.textContent = text;
    return span;
  }

  _icon(icon) {
    const element = document.createElement("ha-icon");
    element.setAttribute("icon", icon && icon.startsWith("mdi:") ? icon : "mdi:view-dashboard");
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

  _applyFrame(block, frame) {
    const x = this._clampNumber(frame?.x, 0, 100, 0);
    const y = this._clampNumber(frame?.y, 0, 100, 0);
    const w = this._clampNumber(frame?.w, 1, 100, 40);
    const h = this._clampNumber(frame?.h, 1, 100, 30);
    block.style.left = `${x}%`;
    block.style.top = `${y}%`;
    block.style.width = `${w}%`;
    block.style.height = `${h}%`;
  }

  _styleClasses(style = {}) {
    return [
      `tone-${this._safeEnum(style.tone, ["neutral", "calm", "warm", "cool", "alert", "success"], "neutral")}`,
      `emphasis-${this._safeEnum(style.emphasis, ["low", "normal", "high", "hero"], "normal")}`,
      `shape-${this._safeEnum(style.shape, ["none", "soft", "pill", "circle"], "soft")}`,
    ].join(" ");
  }

  _presentationClasses(presentation = {}) {
    return [
      `surface-${this._safeEnum(presentation.surface, ["panel", "glass", "ghost", "naked", "hero", "floating", "orb", "strip", "rail"], "panel")}`,
      `scale-${this._safeEnum(presentation.scale, ["micro", "small", "normal", "large", "xl"], "normal")}`,
      `align-${this._safeEnum(presentation.align, ["start", "center", "end", "stretch"], "stretch")}`,
      `layer-${this._safeEnum(presentation.layer, ["backdrop", "base", "raised", "overlay"], "base")}`,
    ].join(" ");
  }

  _animationClasses(animation = {}) {
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
  :host { display: block; }
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

  .layer-backdrop { z-index: 0; pointer-events: none; }
  .layer-base { z-index: 1; }
  .layer-raised { z-index: 2; }
  .layer-overlay { z-index: 3; }
  .align-start { place-self: start stretch; }
  .align-center { place-self: center; }
  .align-end { place-self: end stretch; }
  .align-stretch { place-self: stretch; }

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

  .action-button ha-icon {
    width: 20px;
    height: 20px;
    color: var(--accent);
  }

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

  .visual-node-micro { min-width: 58px; min-height: 50px; padding: 7px; }
  .visual-node-small { min-width: 72px; min-height: 62px; }
  .visual-node-large { min-width: 112px; min-height: 96px; }
  .visual-node-hero { min-width: 148px; min-height: 128px; }
  .visual-node-hero strong { font-size: 34px; }
  .visual-node-circle, .visual-node-orb, .visual-node-core { border-radius: 999px; aspect-ratio: 1; }
  .visual-node-pill { border-radius: 999px; min-height: 54px; grid-template-columns: auto minmax(0, 1fr); text-align: left; }
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

  @media (max-width: 680px) {
    .urdash-card { padding: 14px; }
    .card-header { display: grid; }
    .layout-grid .block-stage { grid-template-columns: 1fr; }
    .layout-grid .block { grid-column: auto !important; grid-row: auto !important; }
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
