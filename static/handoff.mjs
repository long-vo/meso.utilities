// meso.utilities — cross-tool handoff: pass one tool's output to another tool's
// input. The source page writes an envelope to sessionStorage just before
// navigating; the target page consumes it on load. The Storage object is
// injected so the parity tests can exercise this module without a browser.

export const HANDOFF_KEY = "meso-handoff";
/** A handoff is only honoured briefly, so a stale one never surprises later. */
export const HANDOFF_MAX_AGE_MS = 5 * 60 * 1000;
/** Tolerated forward clock skew before an entry is treated as bogus. */
const MAX_FUTURE_SKEW_MS = 60 * 1000;

/** Shape a v1 handoff envelope. `from` is a human label shown by the target. */
export function buildHandoff(target, text, from = "", now = Date.now()) {
  return { v: 1, target: String(target), from: String(from), text: String(text), at: now };
}

/**
 * Parse a raw stored value into `{ text, from }` when it is a valid, fresh
 * envelope addressed to `target` — otherwise null.
 */
export function parseHandoff(raw, target, now = Date.now()) {
  if (typeof raw !== "string" || raw === "") return null;
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return null;
  }
  if (entry === null || typeof entry !== "object" || entry.v !== 1) return null;
  if (entry.target !== target) return null;
  if (typeof entry.text !== "string" || entry.text === "") return null;
  if (typeof entry.at !== "number") return null;
  if (now - entry.at > HANDOFF_MAX_AGE_MS || entry.at - now > MAX_FUTURE_SKEW_MS) return null;
  return { text: entry.text, from: typeof entry.from === "string" ? entry.from : "" };
}

/**
 * Store a handoff for `target`. Returns false when storage is unavailable or
 * full (huge payloads can exceed the sessionStorage quota).
 */
export function sendHandoff(storage, target, text, from = "", now = Date.now()) {
  try {
    storage.setItem(HANDOFF_KEY, JSON.stringify(buildHandoff(target, text, from, now)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Consume the handoff addressed to `target`: return `{ text, from }` and clear
 * it, so a reload never re-applies it. Corrupt or stale leftovers are removed;
 * fresh entries addressed to another tool are left untouched.
 */
export function takeHandoff(storage, target, now = Date.now()) {
  let raw;
  try {
    raw = storage.getItem(HANDOFF_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) return null;
  const entry = parseHandoff(raw, target, now);
  if (entry) {
    storage.removeItem(HANDOFF_KEY);
    return entry;
  }
  let keep = false;
  try {
    const other = JSON.parse(raw);
    keep = other !== null && typeof other === "object" &&
      typeof other.target === "string" && other.target !== target &&
      typeof other.at === "number" && now - other.at <= HANDOFF_MAX_AGE_MS;
  } catch {
    keep = false;
  }
  if (!keep) storage.removeItem(HANDOFF_KEY);
  return null;
}
