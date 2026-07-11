// @ts-check
/**
 * REST Client logic for meso.utilities.
 *
 * Everything here is pure and side-effect free: header-line parsing, auth
 * header building, curl export with shell escaping, URL validation and the
 * little formatting helpers the UI needs. The actual `fetch` lives in the
 * page code (app.js) — this module never touches the network, so the Deno
 * tests can exercise all of it offline.
 *
 * Requests are sent straight from the browser, which means the target API
 * must allow cross-origin (CORS) calls from the page's origin. When it does
 * not, the UI offers the same request as a copyable curl command instead.
 */

/** HTTP methods offered by the composer. */
export const REQUEST_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Methods that must not carry a request body (fetch would reject them). */
export const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

/** How many past requests the history keeps. */
export const HISTORY_LIMIT = 20;

/**
 * @typedef {Object} HeaderEntry
 * @property {string} name
 * @property {string} value
 */

/**
 * @typedef {Object} AuthConfig
 * @property {"none" | "bearer" | "basic"} kind
 * @property {string} [token] bearer token
 * @property {string} [username] basic auth user
 * @property {string} [password] basic auth password
 */

/* --------------------------------- URL ----------------------------------- */

/**
 * Validate (and lightly normalize) the request URL. A missing scheme gets
 * `https://` prepended so `api.example.com/users` just works.
 * @param {string} raw
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
export function validateUrl(raw) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") return { ok: false, error: "Enter a request URL." };
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: `Not a valid URL: ${trimmed}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// URLs are supported." };
  }
  return { ok: true, url: parsed.href };
}

/* -------------------------------- headers -------------------------------- */

/**
 * Parse the headers textarea: one `Name: value` per line. Blank lines and
 * lines starting with `#` are ignored; anything else malformed is reported.
 * @param {string} text
 * @returns {{ headers: HeaderEntry[], errors: string[] }}
 */
export function parseHeaderLines(text) {
  /** @type {HeaderEntry[]} */
  const headers = [];
  /** @type {string[]} */
  const errors = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      errors.push(`Header line ${i + 1} is not "Name: value": ${line}`);
      continue;
    }
    headers.push({ name: match[1], value: match[2] });
  }
  return { headers, errors };
}

/**
 * Is a header with this name (case-insensitive) already present?
 * @param {HeaderEntry[]} headers
 * @param {string} name
 * @returns {boolean}
 */
export function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return headers.some((header) => header.name.toLowerCase() === lower);
}

/**
 * Base64-encode arbitrary (also non-Latin-1) text for Basic auth.
 * @param {string} text
 * @returns {string}
 */
function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Build the Authorization header for the selected auth mode, if any.
 * @param {AuthConfig | undefined} auth
 * @returns {HeaderEntry | undefined}
 */
export function buildAuthHeader(auth) {
  if (!auth || auth.kind === "none") return undefined;
  if (auth.kind === "bearer") {
    const token = (auth.token ?? "").trim();
    if (token === "") return undefined;
    return { name: "Authorization", value: `Bearer ${token}` };
  }
  const username = auth.username ?? "";
  const password = auth.password ?? "";
  if (username === "" && password === "") return undefined;
  return { name: "Authorization", value: `Basic ${encodeBase64(`${username}:${password}`)}` };
}

/**
 * Does the body look like JSON (object or array)?
 * @param {string} body
 * @returns {boolean}
 */
function looksLikeJson(body) {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Assemble the final header list for a request: parsed header lines, plus an
 * Authorization header from the auth helper and a `Content-Type:
 * application/json` for JSON bodies — each only when not already set
 * explicitly (explicit lines always win).
 * @param {{ headerText?: string, auth?: AuthConfig, body?: string, method: string }} request
 * @returns {{
 *   headers: HeaderEntry[],
 *   errors: string[],
 *   isAuthApplied: boolean,
 *   isContentTypeApplied: boolean,
 * }}
 */
export function buildRequestHeaders(request) {
  const { headers, errors } = parseHeaderLines(request.headerText ?? "");
  let isAuthApplied = false;
  let isContentTypeApplied = false;

  const authHeader = buildAuthHeader(request.auth);
  if (authHeader && !hasHeader(headers, "Authorization")) {
    headers.push(authHeader);
    isAuthApplied = true;
  }

  const body = request.body ?? "";
  const isBodySent = body.trim() !== "" && !BODYLESS_METHODS.has(request.method.toUpperCase());
  if (isBodySent && !hasHeader(headers, "Content-Type") && looksLikeJson(body)) {
    headers.push({ name: "Content-Type", value: "application/json" });
    isContentTypeApplied = true;
  }

  return { headers, errors, isAuthApplied, isContentTypeApplied };
}

/* ----------------------------- suggestions ------------------------------- */

/** Header names whose suggested value is a freshly generated UUID. */
const UUID_HEADER_NAMES = new Set(["x-request-id", "x-correlation-id", "idempotency-key"]);

/** Suggested values per header name (lower-cased), shown in the value field. */
const HEADER_VALUE_SUGGESTIONS = {
  "accept": [
    "application/json",
    "application/problem+json",
    "application/xml",
    "text/plain",
    "*/*",
  ],
  "content-type": [
    "application/json",
    "application/x-www-form-urlencoded",
    "application/xml",
    "text/plain",
  ],
  "authorization": ["Bearer ", "Basic "],
  "accept-language": ["de-CH", "en", "fr-CH", "it-CH"],
  "cache-control": ["no-cache", "no-store", "max-age=0"],
  "prefer": ["return=representation", "return=minimal", "respond-async"],
  "if-match": ["*"],
  "if-none-match": ["*"],
  "x-requested-with": ["XMLHttpRequest"],
};

/** Header names offered by the name field, staples first. */
export const HEADER_NAME_SUGGESTIONS = [
  "Accept",
  "Content-Type",
  "Authorization",
  "Accept-Language",
  "Cache-Control",
  "If-Match",
  "If-None-Match",
  "Idempotency-Key",
  "Prefer",
  "X-Api-Key",
  "X-Correlation-Id",
  "X-Request-Id",
  "X-Requested-With",
  "X-Tenant-Id",
];

/**
 * Suggested values for a header name (case-insensitive). UUID-style headers
 * (X-Request-Id, X-Correlation-Id, Idempotency-Key) suggest a freshly
 * generated UUID each call; unknown names get no suggestions.
 * @param {string} name
 * @returns {string[]}
 */
export function suggestHeaderValues(name) {
  const lower = name.trim().toLowerCase();
  if (UUID_HEADER_NAMES.has(lower)) return [crypto.randomUUID()];
  const values = /** @type {Record<string, string[] | undefined>} */ (HEADER_VALUE_SUGGESTIONS)[
    lower
  ];
  return values ? [...values] : [];
}

/**
 * Serialize header rows (from the row-based editor) back into the canonical
 * `Name: value` text used by history entries and {@link parseHeaderLines}.
 * Rows without a name are skipped.
 * @param {HeaderEntry[]} rows
 * @returns {string}
 */
export function serializeHeaderRows(rows) {
  return rows
    .filter((row) => row.name.trim() !== "")
    .map((row) => `${row.name.trim()}: ${row.value.trim()}`)
    .join("\n");
}

/* ------------------------------ environments ------------------------------ */

/**
 * @typedef {Object} RequestTemplate
 * @property {string} method
 * @property {string} url
 * @property {string} [headerText]
 * @property {AuthConfig} [auth]
 * @property {string} [body]
 */

/** Matches `{{name}}` placeholders (whitespace inside the braces allowed). */
const VARIABLE_PATTERN = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * Unique `{{variable}}` names referenced in one string, in order of first use.
 * @param {string} text
 * @returns {string[]}
 */
export function findVariableNames(text) {
  /** @type {string[]} */
  const names = [];
  for (const match of String(text ?? "").matchAll(VARIABLE_PATTERN)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * Unique variable names referenced anywhere in a request template — URL,
 * header lines, auth fields and body.
 * @param {RequestTemplate} request
 * @returns {string[]}
 */
export function collectRequestVariables(request) {
  const auth = request.auth;
  const sources = [
    request.url,
    request.headerText ?? "",
    auth?.token ?? "",
    auth?.username ?? "",
    auth?.password ?? "",
    request.body ?? "",
  ];
  /** @type {string[]} */
  const names = [];
  for (const source of sources) {
    for (const name of findVariableNames(source)) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * Replace `{{name}}` placeholders with values (case-sensitive). Unknown
 * placeholders are left untouched so they stay visible to the caller.
 * @param {string} text
 * @param {Map<string, string>} variables
 * @returns {string}
 */
export function substituteVariables(text, variables) {
  return String(text ?? "").replace(
    VARIABLE_PATTERN,
    (match, name) => variables.has(name) ? /** @type {string} */ (variables.get(name)) : match,
  );
}

/**
 * Build a lookup map from variable rows; blank names are skipped, names are
 * trimmed and case-sensitive, the last duplicate wins.
 * @param {HeaderEntry[]} rows
 * @returns {Map<string, string>}
 */
export function toVariableMap(rows) {
  const map = new Map();
  for (const row of rows ?? []) {
    const name = row.name.trim();
    if (name !== "") map.set(name, row.value);
  }
  return map;
}

/**
 * Find the unterminated `{{prefix` token the caret sits in, for autocomplete.
 * Returns the index of the opening braces and the typed prefix, or undefined
 * when the caret is not inside an open placeholder.
 * @param {string} text
 * @param {number} caret
 * @returns {{ start: number, prefix: string } | undefined}
 */
export function findVariableToken(text, caret) {
  const before = String(text ?? "").slice(0, caret);
  const match = /\{\{\s*([\w.-]*)$/.exec(before);
  if (!match) return undefined;
  return { start: caret - match[0].length, prefix: match[1] };
}

/**
 * Variable names matching a typed prefix (case-insensitive; empty = all).
 * @param {string[]} names
 * @param {string} prefix
 * @returns {string[]}
 */
export function filterVariableNames(names, prefix) {
  const lower = prefix.toLowerCase();
  return names.filter((name) => name.toLowerCase().startsWith(lower));
}

/**
 * Complete the open `{{prefix` token at the caret with `{{name}}`. Any token
 * remainder after the caret — and an existing `}}` — is consumed, so
 * completing in the middle of a placeholder never doubles the braces.
 * @param {string} text
 * @param {number} caret
 * @param {string} name
 * @returns {{ text: string, caret: number }} new text and caret position
 */
export function applyVariableCompletion(text, caret, name) {
  const source = String(text ?? "");
  const token = findVariableToken(source, caret);
  if (!token) return { text: source, caret };
  const after = source.slice(caret).replace(/^[\w.-]*(\s*\}\})?/, "");
  const insertion = `{{${name}}}`;
  return {
    text: source.slice(0, token.start) + insertion + after,
    caret: token.start + insertion.length,
  };
}

/**
 * Substitute every `{{variable}}` in a request template and report the names
 * the active environment could not resolve.
 * @param {RequestTemplate} request
 * @param {Map<string, string>} variables
 * @returns {{ request: RequestTemplate, unresolved: string[] }}
 */
export function resolveRequest(request, variables) {
  const auth = request.auth;
  const resolved = {
    ...request,
    url: substituteVariables(request.url, variables),
    headerText: substituteVariables(request.headerText ?? "", variables),
    body: substituteVariables(request.body ?? "", variables),
    auth: auth
      ? {
        ...auth,
        token: substituteVariables(auth.token ?? "", variables),
        username: substituteVariables(auth.username ?? "", variables),
        password: substituteVariables(auth.password ?? "", variables),
      }
      : undefined,
  };
  const unresolved = collectRequestVariables(request).filter((name) => !variables.has(name));
  return { request: resolved, unresolved };
}

/* --------------------------------- curl ---------------------------------- */

/**
 * Quote a value for POSIX shells: wrap in single quotes, escaping embedded
 * single quotes as `'\''`.
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render the request as a multi-line curl command — the escape hatch for
 * APIs that don't allow cross-origin calls from the browser.
 * @param {{ method: string, url: string, headers: HeaderEntry[], body?: string }} request
 * @returns {string}
 */
export function buildCurlCommand(request) {
  const method = request.method.toUpperCase();
  const parts = [];
  if (method === "GET") {
    parts.push(`curl ${shellQuote(request.url)}`);
  } else if (method === "HEAD") {
    parts.push(`curl --head ${shellQuote(request.url)}`);
  } else {
    parts.push(`curl -X ${method} ${shellQuote(request.url)}`);
  }
  for (const header of request.headers) {
    parts.push(`-H ${shellQuote(`${header.name}: ${header.value}`)}`);
  }
  const body = request.body ?? "";
  if (body !== "" && !BODYLESS_METHODS.has(method)) {
    parts.push(`--data-raw ${shellQuote(body)}`);
  }
  return parts.join(" \\\n  ");
}

/* ------------------------------- responses ------------------------------- */

/**
 * Pretty-print a JSON request body with 2-space indentation. `{{variables}}`
 * inside string values survive untouched; a body with bare (unquoted)
 * placeholders is not valid JSON and is reported instead of being mangled.
 * @param {string} text
 * @returns {{ ok: true, text: string } | { ok: false, error: string }}
 */
export function formatJsonBody(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return { ok: false, error: "Body is empty — nothing to format." };
  try {
    return { ok: true, text: JSON.stringify(JSON.parse(trimmed), null, 2) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Body isn't valid JSON (${reason}). ` +
        "Note: {{variables}} must sit inside quotes to format.",
    };
  }
}

/**
 * Can this content type be rendered as text? Unknown/empty types are treated
 * as text so APIs without a Content-Type still display.
 * @param {string} contentType
 * @returns {boolean}
 */
export function isTextualContentType(contentType) {
  const type = contentType.toLowerCase();
  if (type.trim() === "") return true;
  if (/^text\//.test(type)) return true;
  return /json|xml|javascript|urlencoded|svg|yaml|csv|graphql|problem/.test(type);
}

/**
 * Is this content type JSON-ish (worth pretty-printing)?
 * @param {string} contentType
 * @returns {boolean}
 */
export function isJsonContentType(contentType) {
  return /json/i.test(contentType);
}

/**
 * Explain a failed `fetch` in plain words. Browsers hide the real reason for
 * cross-origin failures, so a TypeError gets the honest CORS speech.
 * @param {unknown} error
 * @returns {string}
 */
export function describeSendError(error) {
  if (error instanceof Error && error.name === "AbortError") {
    return "Request aborted.";
  }
  if (error instanceof TypeError) {
    return "The request never got a response. Most likely the API does not allow cross-origin " +
      "(CORS) calls from this page — or the host is unreachable, or an http:// API was blocked " +
      "on an https page. Copy the request as curl to run it outside the browser.";
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Human-friendly duration: `845 ms`, `1.24 s`.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Human-friendly byte count: `512 B`, `1.3 KB`, `2.4 MB`.
 * @param {number} count
 * @returns {string}
 */
export function formatBytes(count) {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}
