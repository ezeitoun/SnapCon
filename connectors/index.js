// connectors/index.js — registry mapping a printer's `connector` config field
// to its implementation. Adding a new brand means adding one file + one line
// here — nothing else in the app should need to change.
const REGISTRY = {
  "snapmaker-u1-klipper": () => require("./snapmaker-u1-klipper"),
  "klipper-moonraker": () => require("./klipper-moonraker"),
  "creality-klipper": () => require("./creality-klipper"),
  "flashforge-adventurer": () => require("./flashforge-adventurer"),
  "flashforge-ad5x": () => require("./flashforge-ad5x")
};

const DEFAULT_TYPE = "snapmaker-u1-klipper";

// Falls back to the default connector for an unknown/missing type — same
// fallback POST /api/config already applies when validating a printer's
// stored `connector` value.
function getConnector(type) {
  const load = REGISTRY[type] || REGISTRY[DEFAULT_TYPE];
  return load();
}

function listConnectorTypes() {
  return Object.keys(REGISTRY).map(type => {
    const c = getConnector(type);
    return { type, label: c.label || type, capabilities: c.capabilities };
  });
}

module.exports = { getConnector, listConnectorTypes, DEFAULT_TYPE, CONNECTOR_TYPES: Object.keys(REGISTRY) };
