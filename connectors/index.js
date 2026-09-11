// connectors/index.js — registry mapping a printer's `connector` config field
// to its implementation. Adding a new brand means adding one file + one line
// here — nothing else in the app should need to change.
//
// "snapmaker-u1-klipper" is deliberately NOT registered here any more. Its
// module is still very much live code — snapmaker-u1-klipper-ws.js requires
// it directly and delegates everything but status acquisition to it — it
// just isn't a connector a printer can be configured with. Existing configs
// are rewritten to the WS connector at startup (see
// connectors/migrateU1Connector.js), and because an unregistered type falls
// back to DEFAULT_TYPE below, a hand-edited config.json naming the old type
// resolves to the same connector the migration would have given it.
const REGISTRY = {
  "snapmaker-u1-klipper-ws": () => require("./snapmaker-u1-klipper-ws"),
  "klipper-moonraker": () => require("./klipper-moonraker"),
  "creality-klipper": () => require("./creality-klipper"),
  "flashforge-adventurer": () => require("./flashforge-adventurer"),
  "flashforge-ad5x": () => require("./flashforge-ad5x"),
  // Monitoring only — declares capabilities.control === false (see
  // connectors/monitorOnly.js and the connector's own header).
  "bambulab-h2": () => require("./bambulab-h2"),
  "simulator": () => require("./dummy-simulator")
};

const DEFAULT_TYPE = "snapmaker-u1-klipper-ws";

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
    return { type, label: c.label || type, brand: c.brand || c.label || type, capabilities: c.capabilities, address: getAddress(type) };
  });
}

// How a printer on this connector is addressed. `scheme` and `defaultPort`
// build the canonical URL, `portEditable` decides whether Settings offers a
// Port field at all (a connector with a fixed port applies it itself), and
// `required` is false only for connectors with no hardware to reach. Every
// connector declares its own — this fallback just keeps an incomplete
// third-party module from crashing the registry.
const DEFAULT_ADDRESS = { scheme: "http", defaultPort: null, portEditable: true, required: true };
function getAddress(type) {
  const a = getConnector(type).address;
  return a ? { ...DEFAULT_ADDRESS, ...a } : { ...DEFAULT_ADDRESS };
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

module.exports = { getConnector, listConnectorTypes, getCapabilities, getAddress, DEFAULT_TYPE, CONNECTOR_TYPES: Object.keys(REGISTRY) };
