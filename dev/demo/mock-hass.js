export function applyDemoServiceSnapshot(hass, domain, service, data = {}) {
  const entityIds = Array.isArray(data.entity_id) ? data.entity_id : [data.entity_id];
  let states = hass.states;
  let changed = false;
  for (const entityId of entityIds.filter(Boolean)) {
    const current = states[entityId];
    if (!current) continue;
    const next = demoServiceState(domain, service, data, current);
    states = { ...states, [entityId]: next };
    changed = true;
  }
  return changed ? { ...hass, states } : hass;
}

function demoServiceState(domain, service, data, current) {
  let value = current.state;
  const attributes = { ...current.attributes };
  const directStates = {
    turn_on: "on",
    turn_off: "off",
    open_cover: "open",
    close_cover: "closed",
    lock: "locked",
    unlock: "unlocked",
    media_play: "playing",
    media_pause: "paused",
    media_stop: "idle",
    alarm_disarm: "disarmed",
    alarm_arm_home: "armed_home",
    alarm_arm_away: "armed_away",
    alarm_arm_night: "armed_night",
    alarm_arm_vacation: "armed_vacation",
    alarm_trigger: "triggered",
  };
  if (service === "toggle") value = current.state === "on" ? "off" : "on";
  else if (directStates[service]) value = directStates[service];

  if (domain === "light" && service === "turn_on") {
    value = "on";
    if (Number.isFinite(Number(data.brightness_pct))) {
      const percentage = Math.max(0, Math.min(100, Number(data.brightness_pct)));
      attributes.brightness = Math.round((percentage / 100) * 255);
    }
    copyAttributes(attributes, data, ["brightness", "color_temp_kelvin", "rgb_color", "effect"]);
  }
  if (domain === "climate") {
    if (service === "set_hvac_mode" && data.hvac_mode) value = data.hvac_mode;
    copyAttributes(attributes, data, [
      "temperature", "target_temp_low", "target_temp_high", "humidity", "fan_mode",
      "preset_mode", "swing_mode", "swing_horizontal_mode",
    ]);
  }
  if (domain === "fan") {
    copyAttributes(attributes, data, ["percentage", "preset_mode", "oscillating", "direction"]);
    if (["set_percentage", "set_preset_mode", "oscillate", "set_direction"].includes(service)) value = "on";
  }
  if (domain === "cover") {
    if (data.position !== undefined) {
      attributes.current_position = Number(data.position);
      value = Number(data.position) <= 0 ? "closed" : "open";
    }
    if (data.tilt_position !== undefined) attributes.current_tilt_position = Number(data.tilt_position);
  }
  if (domain === "media_player") {
    copyAttributes(attributes, data, [
      "volume_level", "is_volume_muted", "media_position", "source", "sound_mode", "shuffle", "repeat",
    ]);
    if (service === "media_play_pause") value = current.state === "playing" ? "paused" : "playing";
    if (service === "media_next_track") attributes.media_title = "Next track";
    if (service === "media_previous_track") attributes.media_title = "Previous track";
  }

  return {
    ...current,
    state: value,
    attributes,
    last_changed: value === current.state ? current.last_changed : new Date().toISOString(),
    last_updated: new Date().toISOString(),
  };
}

function copyAttributes(target, source, names) {
  for (const name of names) {
    if (source[name] !== undefined) target[name] = source[name];
  }
}
