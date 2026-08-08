// connectors/index.js — registry mapping a printer's `connector` config field
// to its implementation. Adding a new brand means adding one file + one line
// here — nothing else in the app should need to change.
const REGISTRY = {
  "snapmaker-u1-klipper": () => require("./snapmaker-u1-klipper"),
  "klipper-moonraker": () => require("./klipper-moonraker"),
  "creality-klipper": () => require("./creality-klipper"),
  "flashforge-adventurer": () => require("./flashforge-adventurer"),
  "flashforge-ad5x": () => require("./flashforge-ad5x"),
  "simulator": () => require("./dummy-simulator")
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
    return { type, label: c.label || type, brand: c.brand || c.label || type, capabilities: c.capabilities };
  });
}

// Capabilities are usually fixed per connector module, but a handful of
// brands (Creality's K2 line: fixed single-color hotend vs a swappable CFS
// multi-slot box) cover more than one physical configuration under one
// connector — those export a `getCapabilities(printer)` that reads the
// printer's own config (e.g. `filamentMode`) to report the right shape.
// Every other connector doesn't export it, so this falls back to the same
// static `capabilities` object as before.
function getCapabilities(type, printer) {
  const c = getConnector(type);
  return typeof c.getCapabilities === "function" ? c.getCapabilities(printer) : c.capabilities;
}

module.exports = { getConnector, listConnectorTypes, getCapabilities, DEFAULT_TYPE, CONNECTOR_TYPES: Object.keys(REGISTRY) };
