// meso.utilities — shared "show/hide the controls sidebar" logic. The pure
// helpers here (per-tool storage key, serialising the collapsed flag) are
// imported by both sidebar.js (the browser wiring) and the parity tests; all
// DOM handling lives in sidebar.js. The tool id is derived the same way as the
// sidebar width, so both settings key off the same folder name.
import { toolKey } from "./resize.mjs";

/** Per-tool localStorage key for the collapsed state (distinct from the width key). */
export function storageKey(pathname) {
  return `meso-controls-hidden-${toolKey(pathname)}`;
}

/** Serialise the collapsed flag for storage: "1" when hidden, "0" when shown. */
export function serializeHidden(hidden) {
  return hidden ? "1" : "0";
}

/** Parse a stored value back to a boolean; only "1" counts as hidden (junk → shown). */
export function parseHidden(value) {
  return value === "1";
}
