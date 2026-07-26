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
 * Where updates queued for a tool wait. A handoff carries what you are looking
 * at *right now* to the tool you are opening next, so it is short-lived and
 * per-tab. This is the other direction: a change you asked one tool to record
 * in another's data, which has to survive the detour you take before you get
 * there. Hence a durable store (localStorage, so any tab sees it) and no expiry
 * — an entry only leaves the queue when its target has actually applied it.
 */
export const INBOX_KEY = "meso-inbox";

/** A queue entry is only honoured when it is one of ours and names a target. */
function validEntry(entry) {
  return entry !== null && typeof entry === "object" && entry.v === 1 &&
    typeof entry.target === "string";
}

function readInbox(storage) {
  let raw;
  try {
    raw = storage.getItem(INBOX_KEY);
  } catch {
    return [];
  }
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const items = JSON.parse(raw);
    return Array.isArray(items) ? items.filter(validEntry) : [];
  } catch {
    return [];
  }
}

/**
 * Queue `data` for `target` to apply when it next opens. Returns false when
 * storage is unavailable or full. Entries accumulate: saving twice before the
 * target is opened must not lose the first change.
 */
export function queueUpdate(storage, target, data, from = "", now = Date.now()) {
  const items = readInbox(storage);
  items.push({ v: 1, target: String(target), from: String(from), at: now, data });
  try {
    storage.setItem(INBOX_KEY, JSON.stringify(items));
    return true;
  } catch {
    return false;
  }
}

/**
 * Take everything queued for `target`, oldest first, and remove just those
 * entries — another tool's queue is left alone. Callers that cannot apply the
 * changes yet (no data imported) should not call this: what is drained is gone.
 *
 * @returns {Array<{ data: unknown, from: string, at: number }>}
 */
export function drainUpdates(storage, target) {
  const items = readInbox(storage);
  const mine = items.filter((entry) => entry.target === target);
  if (mine.length === 0) return [];
  const rest = items.filter((entry) => entry.target !== target);
  try {
    if (rest.length === 0) storage.removeItem(INBOX_KEY);
    else storage.setItem(INBOX_KEY, JSON.stringify(rest));
  } catch {
    /* the entries stay queued; better a repeat than a silent loss */
  }
  return mine.map((entry) => ({
    data: entry.data,
    from: typeof entry.from === "string" ? entry.from : "",
    at: typeof entry.at === "number" ? entry.at : 0,
  }));
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
