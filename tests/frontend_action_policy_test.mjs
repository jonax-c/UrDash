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
    "sensor.indoor_temperature": {
      entity_id: "sensor.indoor_temperature",
      state: "24",
      attributes: { calibration: { offset: 2 }, unit_of_measurement: "°C" },
    },
    "sensor.outdoor_temperature": {
      entity_id: "sensor.outdoor_temperature",
      state: "30",
      attributes: { unit_of_measurement: "°C" },
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

const averageExpression = {
  op: "round",
  args: [{
    op: "average",
    args: [
      { op: "entity", entity_id: "sensor.indoor_temperature", path: "state" },
      { op: "entity", entity_id: "sensor.outdoor_temperature", path: "state" },
    ],
  }],
  decimals: 1,
};
assert.equal(card._evaluateExpression(averageExpression), 27);
assert.equal(card._evaluateExpression({
  op: "add",
  args: [
    { op: "entity", entity_id: "sensor.indoor_temperature", path: "attributes.calibration.offset" },
    { op: "literal", value: 3 },
  ],
}), 5);
assert.equal(card._evaluateExpression({
  op: "map",
  args: [{ op: "entity", entity_id: "fan.bedroom", path: "state" }],
  cases: [{ when: "on", value: { op: "literal", value: "Cooling" } }],
  default: { op: "literal", value: "Idle" },
}), "Cooling");
assert.equal(card._evaluateExpression({
  op: "convert_unit",
  args: [{ op: "literal", value: 1000 }],
  from_unit: "W",
  to_unit: "kW",
}), 1);
assert.equal(card._evaluateExpression({
  op: "format_duration",
  args: [{ op: "literal", value: 3661 }],
}), "1h 1m 1s");
assert.equal(card._evaluateExpression({ op: "unknown", args: [] }), null);
assert.equal(card._readEntityPath("sensor.indoor_temperature", "attributes.constructor.prototype"), null);
assert.equal(card._isVisible({ visibility: {
  expression: { op: "gt", args: [averageExpression, { op: "literal", value: 25 }] },
} }), true);
assert.deepEqual(card._resolveActionData({ percentage: {
  op: "clamp",
  args: [{ op: "local", name: "selected" }],
  min: 0,
  max: 100,
} }, { selected: 120 }), { percentage: 100 });

const dependencies = card._collectEntityDependencies(validConfig);
assert.deepEqual([...dependencies], []);
const expressionDependencies = card._collectEntityDependencies({ value: averageExpression });
assert.deepEqual([...expressionDependencies].sort(), ["sensor.indoor_temperature", "sensor.outdoor_temperature"]);
const previousHass = card._hass;
const irrelevantHass = { ...previousHass, states: { ...previousHass.states, "sensor.unrelated": { state: "1" } } };
card._entityDependencies = expressionDependencies;
assert.equal(card._dependenciesChanged(previousHass, irrelevantHass), false);
const relevantHass = { ...previousHass, states: { ...previousHass.states, "sensor.indoor_temperature": { ...previousHass.states["sensor.indoor_temperature"], state: "25" } } };
assert.equal(card._dependenciesChanged(previousHass, relevantHass), true);

const weatherCard = new UrDashCard();
let forecastCallback;
let forecastRequest;
let forecastUnsubscribed = false;
let forecastRenders = 0;
Object.defineProperty(weatherCard, "isConnected", { value: true, configurable: true });
weatherCard._render = () => { forecastRenders += 1; };
weatherCard._card = {
  data_sources: [{
    id: "home_daily",
    type: "weather_forecast",
    entity: "weather.home",
    forecast_type: "daily",
    limit: 5,
  }],
};
weatherCard._hass = {
  states: {
    "weather.home": { entity_id: "weather.home", state: "partlycloudy", attributes: { supported_features: 1 } },
  },
  connection: {
    subscribeMessage: async (callback, request) => {
      forecastCallback = callback;
      forecastRequest = request;
      return () => { forecastUnsubscribed = true; };
    },
  },
};
weatherCard._syncDataSources();
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(forecastRequest, {
  type: "weather/subscribe_forecast",
  entity_id: "weather.home",
  forecast_type: "daily",
});
forecastCallback({
  type: "daily",
  forecast: [
    { datetime: "2026-07-11T00:00:00+00:00", condition: "sunny", temperature: 31, templow: 25, unsafe: "drop" },
    { datetime: "2026-07-12T00:00:00+00:00", condition: "rainy", temperature: 28, templow: 23 },
  ],
});
assert.equal(forecastRenders, 1);
assert.equal(weatherCard._readSourcePath("home_daily", "status"), "ready");
assert.equal(weatherCard._readSourcePath("home_daily", "forecast.0.temperature"), 31);
assert.equal(weatherCard._readSourcePath("home_daily", "forecast.0.unsafe"), null);
assert.equal(weatherCard._evaluateExpression({
  op: "concat",
  args: [
    { op: "source", source_id: "home_daily", path: "forecast.0.temperature" },
    { op: "literal", value: "° / " },
    { op: "source", source_id: "home_daily", path: "forecast.0.templow" },
    { op: "literal", value: "°" },
  ],
}), "31° / 25°");
assert.equal(weatherCard._evaluateExpression({
  op: "format_datetime",
  args: [{ op: "source", source_id: "home_daily", path: "forecast.0.datetime" }],
  style: "weekday_short",
  locale: "en-US",
}), "Sat");
weatherCard.disconnectedCallback();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(forecastUnsubscribed, true);

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
