// @ts-check
/**
 * Core JSON field-masking logic for meso.utilities.
 *
 * The masking semantics are ported verbatim from the Slack app's
 * `/sanitize-text` command (slack-slash-app/src/commands/sanitizeText.js) so the
 * website masks a payload in exactly the same way the Slack modal did.
 *
 * This module is intentionally isomorphic and dependency-free: the Deno server
 * imports it for the JSON API, and the browser imports the very same file for
 * the live, in-page preview. One implementation, two runtimes.
 *
 * Rules (unchanged from the original):
 *   - A value is masked whenever its KEY matches one of the target field names
 *     (case-insensitive), at any depth, inside objects and arrays.
 *   - Masking reveals the last N characters and replaces the rest with "*".
 *   - Strings no longer than N are masked entirely (short secrets never leak).
 *   - Strings and numbers are masked; booleans and null are left as-is.
 *   - When a matched key's value is a container, every leaf inside it is masked.
 */

/** The character used to hide a revealed value. */
export const MASK_CHAR = "*";

/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {{ maskedValues: number, matchedKeys: Set<string> }} Stats */

/**
 * Parse a free-form field list into distinct names.
 * Accepts comma-, space- or newline-separated input, e.g. "lastName, email".
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseFields(raw) {
  return String(raw ?? "")
    .split(/[\s,]+/)
    .map((field) => field.trim())
    .filter(Boolean);
}

/**
 * Normalize the "keep last N" input to a non-negative integer (mirrors the
 * original `Math.max(0, parseInt(raw, 10) || 0)`).
 * @param {unknown} raw
 * @returns {number}
 */
export function normalizeKeepLast(raw) {
  const parsed = parseInt(String(raw ?? "0"), 10);
  return Math.max(0, Number.isNaN(parsed) ? 0 : parsed);
}

/**
 * Reveal the last `keepLast` characters and replace the rest with "*".
 * If the string is no longer than keepLast, mask it entirely.
 * @param {string} value
 * @param {number} keepLast
 * @returns {string}
 */
export function maskString(value, keepLast) {
  if (keepLast <= 0) return MASK_CHAR.repeat(value.length);
  if (value.length <= keepLast) return MASK_CHAR.repeat(value.length);
  return MASK_CHAR.repeat(value.length - keepLast) + value.slice(-keepLast);
}

/**
 * Mask a matched value. Handles strings, numbers, arrays, objects and null.
 * Booleans and null pass through unchanged.
 * @param {unknown} val
 * @param {number} keepLast
 * @returns {unknown}
 */
export function maskValue(val, keepLast) {
  if (val === null || val === undefined) return val;
  if (typeof val === "string" || typeof val === "number") {
    return maskString(String(val), keepLast);
  }
  if (Array.isArray(val)) return val.map((item) => maskValue(item, keepLast));
  if (typeof val === "object") {
    /** @type {JsonObject} */
    const out = {};
    for (const [key, nested] of Object.entries(val)) {
      out[key] = maskValue(nested, keepLast);
    }
    return out;
  }
  return val; // booleans left as-is
}

/**
 * Count the leaf values (strings & numbers) that {@link maskValue} would
 * replace — used purely for the "N values masked" statistic.
 * @param {unknown} val
 * @returns {number}
 */
export function countMaskable(val) {
  if (typeof val === "string" || typeof val === "number") return 1;
  if (Array.isArray(val)) {
    return val.reduce((sum, item) => sum + countMaskable(item), 0);
  }
  if (val !== null && typeof val === "object") {
    return Object.values(val).reduce((sum, nested) => sum + countMaskable(nested), 0);
  }
  return 0;
}

/**
 * Recursively walk a JSON value. Whenever a key matches one of the target field
 * names, mask its value; otherwise keep traversing so nested matches are found.
 * @param {unknown} value
 * @param {Set<string>} fieldSet lower-cased key names to mask
 * @param {number} keepLast
 * @param {Stats} [stats] optional accumulator for match statistics
 * @returns {unknown}
 */
export function sanitize(value, fieldSet, keepLast, stats) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, fieldSet, keepLast, stats));
  }
  if (value !== null && typeof value === "object") {
    /** @type {JsonObject} */
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (fieldSet.has(key.toLowerCase())) {
        if (stats) {
          stats.matchedKeys.add(key);
          stats.maskedValues += countMaskable(val);
        }
        out[key] = maskValue(val, keepLast);
      } else {
        out[key] = sanitize(val, fieldSet, keepLast, stats);
      }
    }
    return out;
  }
  return value; // primitive that wasn't under a matched key
}

/**
 * @typedef {Object} SanitizeSuccess
 * @property {true} ok
 * @property {unknown} sanitized the masked value
 * @property {string} pretty pretty-printed (2-space) sanitized JSON
 * @property {string[]} fields the parsed field names
 * @property {number} keepLast the normalized keep-last-N value
 * @property {{ maskedValues: number, matchedKeys: string[], fieldCount: number }} stats
 */

/**
 * @typedef {Object} SanitizeFailure
 * @property {false} ok
 * @property {string} error human-readable reason (e.g. invalid JSON)
 */

/**
 * Full pipeline used by both the API and the browser UI: parse the field list,
 * normalize keep-last-N, validate the JSON, mask it, pretty-print, and collect
 * match statistics.
 * @param {string} jsonText raw JSON payload
 * @param {unknown} fieldsText raw field list (string) or array of names
 * @param {unknown} keepLastRaw raw keep-last-N value
 * @returns {SanitizeSuccess | SanitizeFailure}
 */
export function runSanitize(jsonText, fieldsText, keepLastRaw) {
  const fields = Array.isArray(fieldsText)
    ? fieldsText.map((f) => String(f).trim()).filter(Boolean)
    : parseFields(fieldsText);
  const keepLast = normalizeKeepLast(keepLastRaw);

  let parsed;
  try {
    parsed = JSON.parse(String(jsonText ?? ""));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const fieldSet = new Set(fields.map((f) => f.toLowerCase()));
  /** @type {Stats} */
  const stats = { maskedValues: 0, matchedKeys: new Set() };
  const sanitized = sanitize(parsed, fieldSet, keepLast, stats);

  return {
    ok: true,
    sanitized,
    pretty: JSON.stringify(sanitized, null, 2),
    fields,
    keepLast,
    stats: {
      maskedValues: stats.maskedValues,
      matchedKeys: [...stats.matchedKeys],
      fieldCount: fields.length,
    },
  };
}
