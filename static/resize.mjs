// meso.utilities — shared "resize the controls sidebar" logic. The pure helpers
// here (clamping, per-tool storage key) are imported by both resize.js (the
// browser drag wiring) and the parity tests; all DOM/pointer handling lives in
// resize.js.

/** Default sidebar width, matching the CSS grid fallback (`var(--controls-w, 320px)`). */
export const DEFAULT_WIDTH = 320;
/** Narrowest useful width — the environment editor and history stay legible. */
export const MIN_WIDTH = 240;
/** Widest allowed, so the request/response column never gets squeezed out. */
export const MAX_WIDTH = 560;
/** Pixels moved per Arrow key press when the handle is focused. */
export const STEP = 16;

/** Clamp a value to [MIN_WIDTH, MAX_WIDTH]; non-numeric input falls back to the default. */
export function clampWidth(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(n)));
}

/** Tool id from a pathname: the folder the page lives in (`sanitize`, `decode`, `rest`). */
export function toolKey(pathname) {
  const parts = String(pathname).replace(/\/index\.html$/, "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "root";
}

/** Per-tool localStorage key, so each tool remembers its own sidebar width. */
export function storageKey(pathname) {
  return `meso-controls-w-${toolKey(pathname)}`;
}
