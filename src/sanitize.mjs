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

/* -------------------------- log-file masking --------------------------- */

/**
 * Given the index of an opening "{" in `text`, return the index just past its
 * matching "}", accounting for nested braces and quoted strings (so braces
 * inside string literals don't miscount). Returns -1 if never balanced.
 * @param {string} text
 * @param {number} start index of the "{"
 * @returns {number}
 */
export function findBalancedEnd(text, start) {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Value-shape patterns redacted anywhere in a log, regardless of structure. */
export const REDACT_PATTERNS = [
  // UUID
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  // email
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  // IPv4 (validated octets, requires all four)
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  // IBAN, compact form (e.g. CH9300762011623852957)
  /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
];

/**
 * Redact values by shape (UUIDs, emails, IPs, IBANs) anywhere in the text.
 * @param {string} text
 * @param {number} keepLast
 * @param {RegExp[]} [patterns]
 * @returns {{ text: string, count: number }}
 */
export function redactPatterns(text, keepLast, patterns = REDACT_PATTERNS) {
  let count = 0;
  let out = text;
  for (const re of patterns) {
    out = out.replace(re, (match) => {
      count++;
      return maskString(match, keepLast);
    });
  }
  return { text: out, count };
}

/**
 * Does the inside of a `{...}` look like a flat Java map: `key=value, ...`?
 * @param {string} inner
 * @returns {boolean}
 */
function isJavaMap(inner) {
  return !inner.includes("{") && /^\s*[\w.$-]+\s*=/.test(inner);
}

/**
 * Mask the values of a flat Java `toString` map body (`key=value, key2=value2`).
 * @param {string} inner content between the braces
 * @param {number} keepLast
 * @param {Set<string>} fieldSet
 * @param {boolean} maskAll
 * @returns {{ text: string, masked: number }}
 */
function maskJavaMap(inner, keepLast, fieldSet, maskAll) {
  let masked = 0;
  const text = inner
    .split(", ")
    .map((segment) => {
      const eq = segment.indexOf("=");
      if (eq === -1) return segment;
      const key = segment.slice(0, eq);
      const value = segment.slice(eq + 1);
      if (value === "") return segment;
      if (!(maskAll || fieldSet.has(key.trim().toLowerCase()))) return segment;
      masked++;
      return `${key}=${maskString(value, keepLast)}`;
    })
    .join(", ");
  return { text, masked };
}

/**
 * Scan `{...}` blocks and mask each that is JSON (parsed & masked) or a flat
 * Java map (`{key=value, ...}`). Java object dumps (`class X { ... }`) and
 * other non-JSON braces are left for the line-based pass.
 * @param {string} src
 * @param {number} keepLast
 * @param {Set<string>} fieldSet
 * @param {boolean} maskAll
 * @returns {{ text: string, jsonBlocks: number, mapBlocks: number, masked: number }}
 */
function maskBraceBlocks(src, keepLast, fieldSet, maskAll) {
  const n = src.length;
  let out = "";
  let lastCut = 0;
  let jsonBlocks = 0;
  let mapBlocks = 0;
  let masked = 0;

  for (let i = 0; i < n; i++) {
    if (src[i] !== "{") continue;
    const end = findBalancedEnd(src, i);
    if (end === -1) break;

    const candidate = src.slice(i, end);
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      parsed = undefined;
    }

    if (parsed !== undefined && parsed !== null && typeof parsed === "object") {
      let maskedBlock;
      if (maskAll) {
        maskedBlock = maskValue(parsed, keepLast);
        masked += countMaskable(parsed);
      } else {
        /** @type {Stats} */
        const stats = { maskedValues: 0, matchedKeys: new Set() };
        maskedBlock = sanitize(parsed, fieldSet, keepLast, stats);
        masked += stats.maskedValues;
      }
      out += src.slice(lastCut, i) + JSON.stringify(maskedBlock);
      jsonBlocks++;
      lastCut = end;
      i = end - 1;
      continue;
    }

    const inner = candidate.slice(1, -1);
    if (isJavaMap(inner)) {
      const r = maskJavaMap(inner, keepLast, fieldSet, maskAll);
      out += src.slice(lastCut, i) + "{" + r.text + "}";
      mapBlocks++;
      masked += r.masked;
      lastCut = end;
      i = end - 1;
    }
    // otherwise: not JSON, not a map — leave it; keep scanning for inner blocks
  }
  out += src.slice(lastCut);
  return { text: out, jsonBlocks, mapBlocks, masked };
}

/**
 * Mask the values of Java `toString` object dumps, which print one field per
 * line as `    field: value`. Structure openers (`class ... {`, `[`, `{`) and
 * `null` / empty values are left alone.
 * @param {string} src
 * @param {number} keepLast
 * @param {Set<string>} fieldSet
 * @param {boolean} maskAll
 * @returns {{ text: string, count: number }}
 */
function maskFieldLines(src, keepLast, fieldSet, maskAll) {
  let count = 0;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)([A-Za-z_]\w*):\s(.+)$/.exec(lines[i]);
    if (!m) continue;
    const [, indent, key, value] = m;
    if (value === "null") continue;
    if (value.startsWith("{") || value.startsWith("[") || value.startsWith("class ")) {
      continue; // nested structure opener — handled elsewhere
    }
    if (!(maskAll || fieldSet.has(key.toLowerCase()))) continue;
    lines[i] = `${indent}${key}: ${maskString(value, keepLast)}`;
    count++;
  }
  return { text: lines.join("\n"), count };
}

/**
 * @typedef {Object} LogMaskOptions
 * @property {unknown} [keepLast] trailing characters to keep visible (default 0)
 * @property {string[] | string} [fields] field names to mask when maskAll is false
 * @property {boolean} [maskAll] mask every value in each block (default true)
 * @property {boolean} [redact] also redact UUIDs/IPs/emails/IBANs by shape,
 *   anywhere in the text — even in plain log lines (default false)
 */

/**
 * @typedef {Object} LogStats
 * @property {number} blocks JSON + Java-map blocks masked
 * @property {number} maskedValues total structural values masked
 * @property {number} jsonBlocks
 * @property {number} mapBlocks
 * @property {number} fieldLines Java object-dump field values masked
 * @property {number} patternHits UUID/IP/email/IBAN values redacted
 */

/**
 * Sanitize free-form log text. Masks values inside embedded JSON blocks, flat
 * Java `toString` maps (`{key=value, ...}`) and Java object dumps
 * (`class X { field: value }`), then (optionally) redacts UUIDs, IPs, emails
 * and IBANs anywhere in the text. Surrounding structure — timestamps, logger
 * names, messages — is preserved.
 * @param {string} text
 * @param {LogMaskOptions} [options]
 * @returns {{ text: string, stats: LogStats }}
 */
export function maskLogText(text, options = {}) {
  const { keepLast: keepRaw = 0, fields = [], maskAll = true, redact = false } = options;
  const keepLast = normalizeKeepLast(keepRaw);
  const fieldList = Array.isArray(fields) ? fields : parseFields(fields);
  const fieldSet = new Set(fieldList.map((f) => f.toLowerCase()));

  let src = String(text ?? "");
  let maskedValues = 0;

  const braces = maskBraceBlocks(src, keepLast, fieldSet, maskAll);
  src = braces.text;
  maskedValues += braces.masked;

  const lines = maskFieldLines(src, keepLast, fieldSet, maskAll);
  src = lines.text;
  maskedValues += lines.count;

  let patternHits = 0;
  if (redact) {
    const red = redactPatterns(src, keepLast);
    src = red.text;
    patternHits = red.count;
  }

  return {
    text: src,
    stats: {
      blocks: braces.jsonBlocks + braces.mapBlocks,
      maskedValues,
      jsonBlocks: braces.jsonBlocks,
      mapBlocks: braces.mapBlocks,
      fieldLines: lines.count,
      patternHits,
    },
  };
}

/**
 * @typedef {Object} LogSanitizeResult
 * @property {true} ok
 * @property {string} text the log with every JSON block masked
 * @property {LogStats} stats
 */

/**
 * Convenience wrapper mirroring {@link runSanitize} for log input.
 * @param {string} logText
 * @param {LogMaskOptions} [options]
 * @returns {LogSanitizeResult}
 */
export function runSanitizeLog(logText, options = {}) {
  const { text, stats } = maskLogText(String(logText ?? ""), options);
  return { ok: true, text, stats };
}
