import assert from "node:assert/strict";
import { applyDemoServiceSnapshot } from "../dev/demo/mock-hass.js";

const initial = {
  states: {
    "light.living_room_main": {
      entity_id: "light.living_room_main",
      state: "on",
      attributes: { brightness: 184 },
      last_changed: "2026-01-01T00:00:00Z",
      last_updated: "2026-01-01T00:00:00Z",
    },
    "switch.coffee_station": {
      entity_id: "switch.coffee_station",
      state: "off",
      attributes: {},
      last_changed: "2026-01-01T00:00:00Z",
      last_updated: "2026-01-01T00:00:00Z",
    },
  },
};

const lightOff = applyDemoServiceSnapshot(initial, "light", "toggle", { entity_id: "light.living_room_main" });
assert.equal(lightOff.states["light.living_room_main"].state, "off");
assert.equal(initial.states["light.living_room_main"].state, "on");

const switchOn = applyDemoServiceSnapshot(lightOff, "switch", "toggle", { entity_id: "switch.coffee_station" });
assert.equal(switchOn.states["switch.coffee_station"].state, "on");

const dimmed = applyDemoServiceSnapshot(switchOn, "light", "turn_on", {
  entity_id: "light.living_room_main",
  brightness_pct: 50,
});
assert.equal(dimmed.states["light.living_room_main"].state, "on");
assert.equal(dimmed.states["light.living_room_main"].attributes.brightness, 128);
assert.notEqual(dimmed, switchOn);
assert.notEqual(dimmed.states, switchOn.states);

assert.equal(
  applyDemoServiceSnapshot(dimmed, "switch", "toggle", { entity_id: "switch.missing" }),
  dimmed,
);

console.log("demo mock hass tests passed");
