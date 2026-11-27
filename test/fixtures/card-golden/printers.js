// The printers the card scope guard renders (test/compactCard.test.js): one
// printing, one complete and one error card, each the way /api/fleet reports
// it. Changing one changes every golden file built from it.
const caps = { camera: true, filamentHeads: true, unloadFilament: true, excludeObject: true, webUi: true, headMapping: true };
const heads = [
  { loaded: true, hex: "#F2C200", material: "PLA" },
  { loaded: true, hex: "#101010", material: "PETG" },
  { loaded: false },
  { loaded: true, hex: "#FFFFFF", material: "PLA" },
];

module.exports = {
  printing: {
    id: 11, name: "U1 Left", brand: "SnapMaker", url: "http://192.168.1.40", online: true, state: "printing",
    filename: "Gear box v3.gcode", progress: 0.457, elapsed: 52920, filamentUsed: 77040,
    hotend: { temp: 219.6, target: 220 }, bed: { temp: 45.2, target: 45 }, layer: { current: 88, total: 210 },
    plate: { total: 4, excluded: 1, current: "PART_2" }, activeExt: 1, heads, capabilities: caps, tags: ["farm"],
  },
  complete: {
    id: 12, name: "AD5X White", brand: "FlashForge", transport: "moonraker", url: "http://192.168.1.41", online: true, state: "complete",
    filename: "Bracket.gcode", progress: 1, elapsed: 62820, filamentUsed: 138600, completedAt: Date.UTC(2026, 9, 15, 9, 12),
    hotend: { temp: 31, target: 0 }, bed: { temp: 30, target: 0 }, activeExt: 0, heads, capabilities: { ...caps, excludeObject: false },
  },
  error: {
    id: 13, name: "Creality K1C", brand: "Creality", url: "http://192.168.1.42", online: true, state: "error",
    filename: "Vase.gcode", progress: 0.52, elapsed: 26400, filamentUsed: 20100, errorCode: null, message: "Heater extruder not heating at expected rate",
    hotend: { temp: 120, target: 240 }, bed: { temp: 60, target: 60 }, heads: [], capabilities: { camera: true, webUi: true },
  },
};
