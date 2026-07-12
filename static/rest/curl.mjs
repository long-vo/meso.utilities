// @ts-check
/**
 * curl-command import for the REST Client — the inverse of `buildCurlCommand`
 * in rest.mjs. Parses a pasted curl command (the shape found in tickets, docs
 * and "copy as cURL" exports) back into the composer's request template.
 *
 * The module is dependency-free and isomorphic: the browser imports it for the
 * live UI and the Deno tests import the very same file.
 */

/**
 * Split a shell command into tokens, honouring single quotes, double quotes
 * (with \" \\ \$ \` escapes) and backslash line continuations.
 * @param {string} input
 * @returns {{ tokens: string[] } | { error: string }}
 */
export function tokenizeShell(input) {
  const text = String(input ?? "");
  /** @type {string[]} */
  const tokens = [];
  let current = "";
  let hasCurrent = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return { error: "unterminated single quote" };
      current += text.slice(i + 1, end);
      hasCurrent = true;
      i = end + 1;
    } else if (char === '"') {
      i++;
      let isClosed = false;
      while (i < text.length) {
        const inner = text[i];
        if (inner === '"') {
          isClosed = true;
          i++;
          break;
        }
        if (inner === "\\" && i + 1 < text.length) {
          const next = text[i + 1];
          if (next === '"' || next === "\\" || next === "$" || next === "`") {
            current += next;
            i += 2;
            continue;
          }
          if (next === "\n") {
            i += 2;
            continue;
          }
        }
        current += inner;
        i++;
      }
      if (!isClosed) return { error: "unterminated double quote" };
      hasCurrent = true;
    } else if (char === "\\") {
      if (text[i + 1] === "\n") {
        i += 2; // line continuation
      } else if (i + 1 < text.length) {
        current += text[i + 1];
        hasCurrent = true;
        i += 2;
      } else {
        i++;
      }
    } else if (/\s/.test(char)) {
      if (hasCurrent) {
        tokens.push(current);
        current = "";
        hasCurrent = false;
      }
      i++;
    } else {
      current += char;
      hasCurrent = true;
      i++;
    }
  }
  if (hasCurrent) tokens.push(current);
  return { tokens };
}

/** Boolean flags that are safe to ignore on import. */
const IGNORED_FLAGS = new Set([
  "-s",
  "-S",
  "--silent",
  "--show-error",
  "-v",
  "--verbose",
  "-k",
  "--insecure",
  "--compressed",
  "-L",
  "--location",
  "-i",
  "--include",
  "-g",
  "--globoff",
  "--http1.1",
  "--http2",
  "--fail",
  "-f",
  "--no-progress-meter",
]);

/** Flags whose value we must swallow but do not import. */
const IGNORED_FLAGS_WITH_VALUE = new Set([
  "-o",
  "--output",
  "-w",
  "--write-out",
  "--connect-timeout",
  "-m",
  "--max-time",
  "--retry",
  "-x",
  "--proxy",
  "--cacert",
  "--capath",
  "-c",
  "--cookie-jar",
]);

/** Short flags that take a value and may be written attached (e.g. -XPOST). */
const SHORT_VALUE_FLAGS = new Set(["-X", "-H", "-d", "-u", "-A", "-e", "-b", "-F"]);

/**
 * @typedef {Object} CurlImport
 * @property {true} ok
 * @property {{ method: string, url: string, headerText: string,
 *   auth: { kind: string, token: string, username: string, password: string },
 *   body: string }} request
 * @property {string[]} notes flags/inputs that were ignored, for the toast
 */

/**
 * Parse a curl command into a composer request template.
 * @param {string} text
 * @returns {CurlImport | { ok: false, error: string }}
 */
export function parseCurlCommand(text) {
  const tokenized = tokenizeShell(String(text ?? "").trim());
  if ("error" in tokenized) return { ok: false, error: tokenized.error };
  const tokens = tokenized.tokens;
  if (tokens.length === 0 || !/^curl(\.exe)?$/i.test(tokens[0])) {
    return { ok: false, error: "that doesn't look like a curl command" };
  }

  /** @type {string | undefined} */
  let method;
  /** @type {string | undefined} */
  let url;
  /** @type {{ name: string, value: string }[]} */
  const headers = [];
  /** @type {string[]} */
  const dataParts = [];
  const auth = { kind: "none", token: "", username: "", password: "" };
  /** @type {Set<string>} */
  const notes = new Set();
  let isHead = false;
  let isGet = false;
  let isJson = false;

  let index = 1;
  /** @returns {string | undefined} */
  const takeValue = () => (index < tokens.length ? tokens[index++] : undefined);

  while (index < tokens.length) {
    let token = tokens[index++];
    /** @type {string | undefined} */
    let attached;
    if (token.startsWith("--") && token.includes("=")) {
      const eq = token.indexOf("=");
      attached = token.slice(eq + 1);
      token = token.slice(0, eq);
    } else if (
      /^-[A-Za-z]/.test(token) && token.length > 2 && SHORT_VALUE_FLAGS.has(token.slice(0, 2))
    ) {
      attached = token.slice(2);
      token = token.slice(0, 2);
    }
    const value = () => attached ?? takeValue();

    switch (token) {
      case "-X":
      case "--request":
        method = (value() ?? "").toUpperCase();
        break;
      case "-H":
      case "--header": {
        const raw = value() ?? "";
        const colon = raw.indexOf(":");
        const name = colon === -1 ? raw.trim() : raw.slice(0, colon).trim();
        const headerValue = colon === -1 ? "" : raw.slice(colon + 1).trim();
        const bearer = /^Bearer\s+(.+)$/i.exec(headerValue);
        const basic = /^Basic\s+(.+)$/i.exec(headerValue);
        if (name.toLowerCase() === "authorization" && bearer && auth.kind === "none") {
          auth.kind = "bearer";
          auth.token = bearer[1];
        } else if (name.toLowerCase() === "authorization" && basic && auth.kind === "none") {
          const decoded = decodeBasicCredentials(basic[1]);
          if (decoded) {
            auth.kind = "basic";
            auth.username = decoded.username;
            auth.password = decoded.password;
          } else {
            headers.push({ name, value: headerValue });
          }
        } else if (name !== "") {
          headers.push({ name, value: headerValue });
        }
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii": {
        const body = value() ?? "";
        if (body.startsWith("@")) notes.add(`file body ${body} was not read`);
        else dataParts.push(body);
        break;
      }
      case "--data-urlencode": {
        const raw = value() ?? "";
        const eq = raw.indexOf("=");
        dataParts.push(
          eq === -1
            ? encodeURIComponent(raw)
            : `${raw.slice(0, eq)}=${encodeURIComponent(raw.slice(eq + 1))}`,
        );
        break;
      }
      case "--json":
        dataParts.push(value() ?? "");
        isJson = true;
        break;
      case "-u":
      case "--user": {
        const raw = value() ?? "";
        const colon = raw.indexOf(":");
        auth.kind = "basic";
        auth.username = colon === -1 ? raw : raw.slice(0, colon);
        auth.password = colon === -1 ? "" : raw.slice(colon + 1);
        break;
      }
      case "-A":
      case "--user-agent":
        headers.push({ name: "User-Agent", value: value() ?? "" });
        break;
      case "-e":
      case "--referer":
        headers.push({ name: "Referer", value: value() ?? "" });
        break;
      case "-b":
      case "--cookie":
        headers.push({ name: "Cookie", value: value() ?? "" });
        break;
      case "-F":
      case "--form":
        return { ok: false, error: "multipart form data (-F) can't be imported" };
      case "--url":
        url = value();
        break;
      case "-I":
      case "--head":
        isHead = true;
        break;
      case "-G":
      case "--get":
        isGet = true;
        break;
      default:
        if (IGNORED_FLAGS.has(token)) {
          // silently fine — cosmetic transfer options
        } else if (IGNORED_FLAGS_WITH_VALUE.has(token)) {
          if (attached === undefined) takeValue();
          notes.add(`${token} ignored`);
        } else if (token.startsWith("-")) {
          notes.add(`${token} ignored`);
        } else if (url === undefined) {
          url = token;
        } else {
          notes.add(`extra argument "${token}" ignored`);
        }
    }
  }

  if (url === undefined || url === "") {
    return { ok: false, error: "no URL found in the command" };
  }

  let body = dataParts.join("&");
  if (isGet && body !== "") {
    url += (url.includes("?") ? "&" : "?") + body;
    body = "";
  }
  if (isJson) {
    const names = new Set(headers.map((header) => header.name.toLowerCase()));
    if (!names.has("content-type")) {
      headers.push({ name: "Content-Type", value: "application/json" });
    }
    if (!names.has("accept")) headers.push({ name: "Accept", value: "application/json" });
  }

  return {
    ok: true,
    request: {
      method: method ?? (isHead ? "HEAD" : body !== "" ? "POST" : "GET"),
      url,
      headerText: headers.map((header) => `${header.name}: ${header.value}`).join("\n"),
      auth,
      body,
    },
    notes: [...notes],
  };
}

/**
 * Decode the payload of a `Basic dXNlcjpwYXNz` header.
 * @param {string} encoded
 * @returns {{ username: string, password: string } | undefined}
 */
function decodeBasicCredentials(encoded) {
  try {
    const decoded = atob(encoded.trim());
    const colon = decoded.indexOf(":");
    if (colon === -1) return undefined;
    return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
  } catch {
    return undefined;
  }
}
