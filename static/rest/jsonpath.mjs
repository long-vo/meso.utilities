// @ts-check
/**
 * Minimal JSON-path extraction for the REST Client — powers "capture into
 * variable" and the response path preview. Supports the everyday subset:
 * `$.a.b`, `a.b`, `[0]`, `['key with spaces']`, `["key"]` and any mix.
 *
 * The module is dependency-free and isomorphic: the browser imports it for the
 * live UI and the Deno tests import the very same file.
 */

/**
 * Parse a path into segments (strings for keys, numbers for array indexes).
 * @param {string} path
 * @returns {{ segments: (string | number)[] } | { error: string }}
 */
export function parseJsonPath(path) {
  let rest = String(path ?? "").trim();
  if (rest === "") return { error: "empty path" };
  if (rest === "$") return { segments: [] };
  if (rest.startsWith("$")) rest = rest.slice(1);
  /** @type {(string | number)[]} */
  const segments = [];
  while (rest.length > 0) {
    let match;
    if ((match = /^\.([A-Za-z_$][\w$-]*)/.exec(rest))) {
      segments.push(match[1]);
    } else if ((match = /^\[(\d+)\]/.exec(rest))) {
      segments.push(Number(match[1]));
    } else if ((match = /^\['((?:[^'\\]|\\.)*)'\]/.exec(rest))) {
      segments.push(match[1].replace(/\\(.)/g, "$1"));
    } else if ((match = /^\["((?:[^"\\]|\\.)*)"\]/.exec(rest))) {
      segments.push(match[1].replace(/\\(.)/g, "$1"));
    } else if (segments.length === 0 && (match = /^([A-Za-z_$][\w$-]*)/.exec(rest))) {
      segments.push(match[1]); // bare leading key, e.g. "data.items"
    } else {
      return { error: `cannot parse the path at "${rest.slice(0, 12)}"` };
    }
    rest = rest.slice(match[0].length);
  }
  return { segments };
}

/**
 * Walk `root` along `path`.
 * @param {unknown} root
 * @param {string} path
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
export function extractJsonPath(root, path) {
  const parsed = parseJsonPath(path);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  let current = root;
  for (const segment of parsed.segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        return { ok: false, error: `[${segment}] used on a non-array` };
      }
      if (segment >= current.length) {
        return { ok: false, error: `index ${segment} out of range (length ${current.length})` };
      }
      current = current[segment];
    } else {
      if (current === null || typeof current !== "object" || Array.isArray(current)) {
        return { ok: false, error: `"${segment}" used on a non-object` };
      }
      const record = /** @type {Record<string, unknown>} */ (current);
      if (!(segment in record)) return { ok: false, error: `key "${segment}" not found` };
      current = record[segment];
    }
  }
  return { ok: true, value: current };
}

/**
 * Turn an extracted value into the string stored in an environment variable:
 * strings stay as-is, everything else becomes JSON.
 * @param {unknown} value
 * @returns {string}
 */
export function variableStringFor(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}
