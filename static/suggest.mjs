// meso.utilities — sensitive-field suggestions for the Sanitize JSON tool.
// Scans a parsed JSON payload for keys that LOOK sensitive — by key name or by
// value shape — but are not in the mask list yet. Complements the log-mode
// "Redact IDs" toggle, which is value-shape only. Pure logic (no DOM),
// imported by the browser UI and the parity tests.

/** Key-name patterns worth masking, with the reason shown on the chip. */
const KEY_PATTERNS = [
  [/pass(word)?|passwd|pwd|secret|credential/i, "key name suggests a secret"],
  [
    /token|api[-_]?key|authorization|authentication|bearer|session[-_]?id/i,
    "key name suggests a credential",
  ],
  [/e-?mail/i, "key name suggests an email"],
  [/phone|mobile|msisdn/i, "key name suggests a phone number"],
  [/iban|bic|card[-_]?(number|no)\b|account[-_]?(number|no)\b/i, "key name suggests a bank detail"],
  [/ssn|social[-_]?security|tax[-_]?id|passport/i, "key name suggests a government ID"],
  [/(first|last|full|sur|given|family|middle)[-_]?name/i, "key name suggests a person's name"],
  [/birth(day|date)?|^dob$|[-_]dob$/i, "key name suggests a birth date"],
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Value-shape checks (strings only), most specific first. */
const VALUE_CHECKS = [
  {
    reason: "value looks like an email",
    test: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s),
  },
  {
    reason: "value looks like an IBAN",
    test: (s) => {
      const compact = s.replace(/ /g, "");
      return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact) && /^[A-Z0-9 ]+$/.test(s.trim());
    },
  },
  {
    reason: "value looks like a JWT",
    test: (s) => /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(s),
  },
  {
    reason: "value looks like a PEM block",
    test: (s) => s.includes("-----BEGIN "),
  },
  {
    reason: "value looks like a card number",
    test: (s) => /^[\d -]+$/.test(s) && /^\d{13,19}$/.test(s.replace(/[ -]/g, "")),
  },
  {
    reason: "value looks like a phone number",
    test: (s) => /^\+[\d ()/.-]{8,}$/.test(s) && (s.match(/\d/g) ?? []).length >= 9,
  },
  {
    reason: "value looks like a token",
    test: (s) =>
      s.length >= 20 && !UUID_RE.test(s) && /^[\w+/=.-]+$/.test(s) &&
      /[A-Za-z]/.test(s) && /\d/.test(s),
  },
];

function keyReason(key) {
  for (const [pattern, reason] of KEY_PATTERNS) {
    if (pattern.test(key)) return reason;
  }
  return undefined;
}

/** True when the value contains at least one maskable leaf (string/number). */
function hasMaskableLeaf(value, depth = 0) {
  if (typeof value === "string" || typeof value === "number") return true;
  if (value === null || typeof value !== "object" || depth > 6) return false;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => hasMaskableLeaf(child, depth + 1));
}

/** Shape-based reason for a scalar value or a small array of scalars. */
function valueReason(value) {
  const samples = Array.isArray(value) ? value.slice(0, 5) : [value];
  for (const sample of samples) {
    if (typeof sample !== "string" || sample === "") continue;
    for (const { reason, test } of VALUE_CHECKS) {
      if (test(sample)) return reason;
    }
  }
  return undefined;
}

/**
 * Suggest keys of `root` (a parsed JSON value) that look sensitive but are
 * missing from `existingFields` (compared case-insensitively, like masking).
 * Returns `[{ name, reason }]` in discovery order, capped at `limit`.
 */
export function suggestSensitiveFields(root, existingFields = [], limit = 8) {
  const existing = new Set(existingFields.map((field) => String(field).toLowerCase()));
  const found = new Map();
  const queue = [{ value: root, depth: 0 }];
  let visited = 0;

  while (queue.length > 0) {
    const { value, depth } = queue.shift();
    if (++visited > 2000 || depth > 8 || value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const item of value) queue.push({ value: item, depth: depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (!existing.has(lower) && !found.has(lower)) {
        // A key-name match only counts when there is something maskable under
        // it — booleans and nulls are never masked, so never suggested.
        let reason = keyReason(key);
        if (reason !== undefined && !hasMaskableLeaf(child)) reason = undefined;
        if (reason === undefined) reason = valueReason(child);
        if (reason !== undefined) found.set(lower, { name: key, reason });
      }
      if (child !== null && typeof child === "object") {
        queue.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return [...found.values()].slice(0, limit);
}
