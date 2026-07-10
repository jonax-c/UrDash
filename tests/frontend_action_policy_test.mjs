import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const manifest = JSON.parse(
  await readFile(new URL("../custom_components/urdash/frontend/action-manifest.json", import.meta.url), "utf8"),
);
const cardSchema = JSON.parse(
  await readFile(new URL("../custom_components/urdash/frontend/card-schema-v2.json", import.meta.url), "utf8"),
);
const registry = new Map();

globalThis.fetch = async (url) => ({
  ok: true,
  status: 200,
  json: async () => String(url).includes("card-schema-v2.json") ? cardSchema : manifest,
});
globalThis.HTMLElement = class {
  attachShadow() {
    this.shadowRoot = {};
  }

  dispatchEvent(event) {
    this.dispatchedEvents = [...(this.dispatchedEvents || []), event];
    return true;
  }
};
globalThis.CustomEvent = class {
  constructor(type, options) {
    this.type = type;
    this.detail = options?.detail;
  }
};
globalThis.customElements = {
  define: (name, constructor) => registry.set(name, constructor),
  get: (name) => registry.get(name),
};
globalThis.window = {
  customCards: [],
  confirm: () => true,
  dispatchEvent: () => true,
  setTimeout,
  clearTimeout,
};
globalThis.history = { pushState: () => {} };

const rendererUrl = pathToFileURL(
  new URL("../custom_components/urdash/frontend/urdash-custom-card.js", import.meta.url).pathname,
);
rendererUrl.searchParams.set("test", "action-policy");
await import(rendererUrl.href);

const UrDashCard = registry.get("urdash-card");
assert.ok(UrDashCard, "custom card module should register urdash-card");

const card = new UrDashCard();
const validConfig = {
  type: "custom:urdash-card",
  urdash_schema: 2,
  height_mode: "auto",
  card: {
    intent: {
      goal: "sensor_summary",
      title: "Test",
      summary: "Frontend schema fixture",
      risk_level: "low",
      primary_entities: [],
      primary_actions: [],
    },
    layout: {
      type: "grid",
      blocks: [{ id: "text", kind: "text", text: "Safe" }],
    },
  },
};
assert.equal(card._normalizeConfig(validConfig).urdash_schema_minor, 0);
assert.throws(
  () => card._normalizeConfig({ ...validConfig, raw_html: "<script>alert(1)</script>" }),
  (error) => error.diagnostics?.[0]?.code === "schema.additional_property",
);
assert.throws(
  () => card._normalizeConfig({ ...validConfig, urdash_schema_minor: 1 }),
  (error) => error.diagnostics?.[0]?.code === "schema.maximum",
);

let serviceCalls = 0;
card._hass = {
  states: {
    "light.desk": {
      entity_id: "light.desk",
      state: "on",
      attributes: { supported_features: 0, supported_color_modes: ["rgb"] },
    },
    "fan.bedroom": {
      entity_id: "fan.bedroom",
      state: "on",
      attributes: { supported_features: 0 },
    },
    "cover.garage": {
      entity_id: "cover.garage",
      state: "closed",
      attributes: { supported_features: 1, device_class: "garage" },
    },
    "lock.front_door": {
      entity_id: "lock.front_door",
      state: "locked",
      attributes: { supported_features: 0 },
    },
  },
  services: {
    light: { turn_on: {} },
    fan: { set_percentage: {} },
    cover: { open_cover: {} },
    lock: { unlock: {} },
  },
  callService: async () => {
    serviceCalls += 1;
    await Promise.resolve();
  },
};

const validLightAction = {
  type: "service",
  domain: "light",
  service: "turn_on",
  entity_id: "light.desk",
  data: { brightness_pct: 50, rgb_color: [120, 180, 255] },
};
assert.equal(card._actionAllowed(validLightAction), true);
assert.equal(card._actionAllowed({ ...validLightAction, data: { brightness_pct: 101 } }), false);
assert.equal(card._actionAllowed({ ...validLightAction, data: { unsupported: true } }), false);
assert.equal(card._actionAllowed({ ...validLightAction, domain: "switch" }), false);
assert.equal(card._actionAllowed({ ...validLightAction, entity_id: "light.missing" }), false);

const unsupportedFanAction = {
  type: "service",
  domain: "fan",
  service: "set_percentage",
  entity_id: "fan.bedroom",
  data: { percentage: 50 },
};
assert.equal(card._actionAllowed(unsupportedFanAction), false);

const garageAction = {
  type: "service",
  domain: "cover",
  service: "open_cover",
  entity_id: "cover.garage",
};
assert.equal(card._actionAllowed(garageAction), true);
assert.equal(card._requiresConfirmation(garageAction), true);
assert.equal(card._requiresConfirmation({
  type: "service",
  domain: "lock",
  service: "unlock",
  entity_id: "lock.front_door",
}), true);

assert.equal(card._navigationAllowed("/lovelace/home"), true);
assert.equal(card._navigationAllowed("//external.example"), false);
assert.equal(card._navigationAllowed("javascript:alert(1)"), false);

await Promise.all([
  card._runAction(validLightAction),
  card._runAction(validLightAction),
]);
assert.equal(serviceCalls, 1, "duplicate in-flight actions should be collapsed");

await card._runAction({ ...validLightAction, data: { brightness_pct: -1 } });
assert.equal(serviceCalls, 1, "denied actions must never reach hass.callService");

const classes = new Set();
const feedbackElement = {
  disabled: false,
  isConnected: true,
  title: "",
  classList: {
    add: (...names) => names.forEach((name) => classes.add(name)),
    remove: (...names) => names.forEach((name) => classes.delete(name)),
  },
  setAttribute: () => {},
  removeAttribute: () => {},
};
card._actionTimeoutMs = 5;
card._hass.callService = async () => new Promise(() => {});
await card._runAction(validLightAction, { element: feedbackElement });
assert.equal(classes.has("action-error"), true, "timeouts should expose an error state");
assert.match(feedbackElement.title, /timed out/i);
assert.equal(card.dispatchedEvents.at(-1)?.type, "urdash-action-error");

console.log("frontend action policy tests passed");
