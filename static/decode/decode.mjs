// @ts-check
/**
 * Decode-anything logic for meso.utilities.
 *
 * Takes an opaque blob of text and repeatedly detects + unwraps one encoding
 * layer at a time — Base64 (standard and URL-safe), hex, URL percent-encoding,
 * gzip/zlib, JWTs, PEM armor, `data:` URLs and JSON-escaped strings — until
 * something readable comes out or nothing more applies.
 *
 * Every detector is deliberately conservative: a decode is only accepted when
 * the result is readable UTF-8 text or a recognised binary format, so ordinary
 * prose, paths and IDs fall through untouched instead of turning into noise.
 *
 * The module is dependency-free and isomorphic: the browser imports it for the
 * live UI and the Deno tests import the very same file.
 */

/** Maximum number of unwrap steps before decoding gives up. */
export const MAX_STEPS = 12;

/** Bytes shown in a binary hex preview before it is truncated. */
const PREVIEW_BYTES = 192;

/**
 * @typedef {Object} DecodeStep
 * @property {string} kind machine-readable step type (e.g. "base64", "gzip")
 * @property {string} label human-readable encoding name shown in the UI
 * @property {string} text decoded text, pretty-printed JSON or a hex preview
 * @property {string} [note] extra detail (byte counts, JWT expiry, format)
 * @property {boolean} isBinary true when `text` is a hex preview of raw bytes
 * @property {Uint8Array} [bytes] raw bytes of a binary step (for download)
 */

/**
 * @typedef {DecodeStep & {
 *   next?: { text: string } | { bytes: Uint8Array } | undefined,
 * }} InternalStep the pipeline step plus what the next iteration consumes
 */

/**
 * @typedef {Object} DecodeResult
 * @property {DecodeStep[]} steps applied decodings, in order
 * @property {DecodeStep} [final] the last step, if anything was decoded
 */

/* ------------------------------ byte helpers ----------------------------- */

/**
 * Decode standard or URL-safe Base64 into bytes. Whitespace must already be
 * stripped. Returns undefined when the input is not valid Base64.
 * @param {string} compact
 * @param {boolean} isUrlSafe
 * @returns {Uint8Array | undefined}
 */
export function decodeBase64Bytes(compact, isUrlSafe) {
  if (compact.length === 0 || compact.length % 4 === 1) return undefined;
  const standard = isUrlSafe ? compact.replace(/-/g, "+").replace(/_/g, "/") : compact;
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/**
 * Strictly decode bytes as UTF-8. Returns undefined for invalid sequences.
 * @param {Uint8Array} bytes
 * @returns {string | undefined}
 */
function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Is this decoded text something a human can read? Rejects any control
 * character other than tab/newline/carriage-return (and U+FFFD), which is
 * what separates a real decode from Base64/hex false positives.
 * @param {string} text
 * @returns {boolean}
 */
export function isReadableText(text) {
  if (text.length === 0) return false;
  // deno-lint-ignore no-control-regex
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/.test(text);
}

/**
 * Classic hex dump (offset · hex bytes · ASCII), truncated after
 * {@link PREVIEW_BYTES} bytes so huge blobs stay cheap to render.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function hexPreview(bytes) {
  const rows = [];
  const shown = Math.min(bytes.length, PREVIEW_BYTES);
  for (let offset = 0; offset < shown; offset += 16) {
    const slice = bytes.subarray(offset, Math.min(offset + 16, shown));
    const hex = [...slice].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...slice]
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");
    rows.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  |${ascii}|`);
  }
  if (bytes.length > shown) rows.push(`… ${bytes.length - shown} more bytes`);
  return rows.join("\n");
}

/** Known magic numbers, checked when decoded bytes are not readable text. */
const BYTE_SIGNATURES = [
  { name: "PDF document", extension: ".pdf", magic: [0x25, 0x50, 0x44, 0x46] },
  { name: "PNG image", extension: ".png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { name: "JPEG image", extension: ".jpg", magic: [0xff, 0xd8, 0xff] },
  { name: "GIF image", extension: ".gif", magic: [0x47, 0x49, 0x46, 0x38] },
  { name: "ZIP archive (also docx/xlsx/jar)", extension: ".zip", magic: [0x50, 0x4b, 0x03, 0x04] },
  { name: "DER / ASN.1 (certificate or key)", extension: ".der", magic: [0x30, 0x82] },
  { name: "ELF binary", extension: ".bin", magic: [0x7f, 0x45, 0x4c, 0x46] },
  { name: "Java class file", extension: ".class", magic: [0xca, 0xfe, 0xba, 0xbe] },
  { name: "WebAssembly module", extension: ".wasm", magic: [0x00, 0x61, 0x73, 0x6d] },
];

/**
 * @typedef {(
 *   | { type: "gzip" | "zlib" | "unknown" }
 *   | { type: "text", text: string }
 *   | { type: "signature", name: string, extension: string }
 * )} ByteClassification
 */

/**
 * Decide what a freshly decoded byte buffer is: compressed, readable text,
 * a recognised binary format, or nothing we know.
 * @param {Uint8Array} bytes
 * @returns {ByteClassification}
 */
export function classifyBytes(bytes) {
  if (bytes.length < 2) {
    const text = decodeUtf8(bytes);
    return text !== undefined && isReadableText(text)
      ? { type: "text", text }
      : { type: "unknown" };
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return { type: "gzip" };
  if (bytes[0] === 0x78 && (bytes[0] * 256 + bytes[1]) % 31 === 0) return { type: "zlib" };
  const text = decodeUtf8(bytes);
  if (text !== undefined && isReadableText(text)) return { type: "text", text };
  for (const signature of BYTE_SIGNATURES) {
    if (signature.magic.every((byte, i) => bytes[i] === byte)) {
      return { type: "signature", name: signature.name, extension: signature.extension };
    }
  }
  return { type: "unknown" };
}

/**
 * Build a pipeline step out of decoded bytes. Rejects (returns undefined)
 * when the bytes are unrecognisable — unless `acceptUnknown` is set, which
 * explicit containers (gzip output, PEM bodies, data: URLs) use because their
 * framing already proved the decode was intentional.
 * @param {string} kind
 * @param {string} label
 * @param {Uint8Array} bytes
 * @param {{ acceptUnknown?: boolean }} [options]
 * @returns {InternalStep | undefined}
 */
function stepFromBytes(kind, label, bytes, options = {}) {
  const classified = classifyBytes(bytes);
  switch (classified.type) {
    case "text":
      return {
        kind,
        label,
        text: classified.text,
        note: `${bytes.length} bytes of UTF-8 text`,
        isBinary: false,
        next: { text: classified.text },
      };
    case "gzip":
    case "zlib":
      return {
        kind,
        label,
        text: hexPreview(bytes),
        note: `${classified.type}-compressed data · ${bytes.length} bytes`,
        isBinary: true,
        bytes,
        next: { bytes },
      };
    case "signature":
      return {
        kind,
        label,
        text: hexPreview(bytes),
        note: `${classified.name} · ${bytes.length} bytes`,
        isBinary: true,
        bytes,
        next: undefined,
      };
    default:
      if (!options.acceptUnknown) return undefined;
      return {
        kind,
        label,
        text: hexPreview(bytes),
        note: `binary · ${bytes.length} bytes`,
        isBinary: true,
        bytes,
        next: undefined,
      };
  }
}

/* ----------------------------- text detectors ---------------------------- */

/**
 * `data:` URLs — unwrap the payload (base64 or percent-encoded).
 * @param {string} text
 * @returns {InternalStep | undefined}
 */
function detectDataUrl(text) {
  const match = /^data:([^,]*),([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  const [, meta, payload] = match;
  if (/;base64$/i.test(meta)) {
    const bytes = decodeBase64Bytes(payload.replace(/\s+/g, ""), false);
    if (!bytes) return undefined;
    return stepFromBytes("data-url", "data: URL (Base64)", bytes, { acceptUnknown: true });
  }
  try {
    const decoded = decodeURIComponent(payload);
    return {
      kind: "data-url",
      label: "data: URL",
      text: decoded,
      isBinary: false,
      next: { text: decoded },
    };
  } catch {
    return undefined;
  }
}

/**
 * Parse one Base64url JWT segment into a JSON object (or undefined).
 * @param {string} segment
 * @returns {Record<string, unknown> | undefined}
 */
function parseBase64UrlJson(segment) {
  const bytes = decodeBase64Bytes(segment, true);
  if (!bytes) return undefined;
  const text = decodeUtf8(bytes);
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? /** @type {Record<string, unknown>} */ (value)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Describe a JWT `exp` claim relative to now.
 * @param {unknown} exp
 * @returns {string | undefined}
 */
function describeJwtExpiry(exp) {
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
  const when = new Date(exp * 1000).toISOString();
  return exp * 1000 < Date.now() ? `expired ${when}` : `expires ${when}`;
}

/**
 * JWTs — three Base64url segments; the header must carry an `alg`.
 * Terminal: header and payload are shown, the signature is not verified.
 * @param {string} text
 * @returns {InternalStep | undefined}
 */
function detectJwt(text) {
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)$/.exec(text);
  if (!match) return undefined;
  const [, headerPart, payloadPart, signaturePart] = match;
  const header = parseBase64UrlJson(headerPart);
  if (!header || typeof header.alg !== "string") return undefined;
  const payload = parseBase64UrlJson(payloadPart);
  if (!payload) return undefined;
  const notes = [`alg ${header.alg}`];
  const expiry = describeJwtExpiry(payload.exp);
  if (expiry) notes.push(expiry);
  notes.push(signaturePart ? "signature not verified" : "no signature");
  return {
    kind: "jwt",
    label: "JWT",
    text: JSON.stringify({ header, payload }, null, 2),
    note: notes.join(" · "),
    isBinary: false,
    next: undefined,
  };
}

/**
 * PEM armor (`-----BEGIN X----- … -----END X-----`) — decode the body.
 * @param {string} text
 * @returns {InternalStep | undefined}
 */
function detectPem(text) {
  const match = /^-----BEGIN ([A-Z0-9 ]+)-----\r?\n([\s\S]+?)\r?\n-----END \1-----\s*$/.exec(text);
  if (!match) return undefined;
  const bytes = decodeBase64Bytes(match[2].replace(/\s+/g, ""), false);
  if (!bytes) return undefined;
  return stepFromBytes("pem", `PEM (${match[1].toLowerCase()})`, bytes, { acceptUnknown: true });
}

/**
 * A whole JSON string literal (`"…"`) — unwrap the quotes and keep going.
 * @param {string} text
 * @returns {InternalStep | undefined}
 */
function detectQuotedString(text) {
  if (!/^"[\s\S]*"$/.test(text)) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "string" || parsed === text) return undefined;
  return {
    kind: "json-string",
    label: "Quoted JSON string",
    text: parsed,
    isBinary: false,
    next: { text: parsed },
  };
}

/**
 * JSON-escaped text — stringified JSON pasted from a log, like
 * `{\"logonId\":\"L006344\"}`, or `\uXXXX` escapes. Requires an escaped quote
 * or unicode escape so Windows paths (`C:\temp`) are never touched.
 * @param {string} text
 * @returns {InternalStep | undefined}
 */
function detectEscapedText(text) {
  if (!/\\"|\\u[0-9a-fA-F]{4}/.test(text)) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(`"${text}"`);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "string" || parsed === text) return undefined;
  return {
    kind: "escaped",
    label: "JSON-escaped text",
    text: parsed,
    isBinary: false,
    next: { text: parsed },
  };
}

/**
 * URL percent-encoding — only when `%XX` sequences are present and decoding
 * actually changes the text.
 * @param {string} text
 * @returns {InternalStep | undefined}
 */
function detectUrlEncoded(text) {
  if (!/%[0-9A-Fa-f]{2}/.test(text)) return undefined;
  let decoded;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    return undefined;
  }
  if (decoded === text) return undefined;
  return {
    kind: "url",
    label: "URL percent-encoding",
    text: decoded,
    isBinary: false,
    next: { text: decoded },
  };
}

/**
 * Hex — an even run of ≥ 8 hex digits (whitespace/colon separators and a
 * leading 0x allowed). The decoded bytes must classify as something real.
 * @param {string} text
 * @returns {InternalStep | undefined}
 */
function detectHex(text) {
  let compact = text;
  if (/^0x/i.test(compact)) compact = compact.slice(2);
  compact = compact.replace(/[\s:]+/g, "");
  if (compact.length < 8 || compact.length % 2 !== 0) return undefined;
  if (!/^[0-9a-fA-F]+$/.test(compact)) return undefined;
  const bytes = new Uint8Array(compact.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  }
  return stepFromBytes("hex", "Hex", bytes);
}

/**
 * Base64, standard or URL-safe — the decoded bytes must classify as readable
 * text, compressed data or a known binary format, so ordinary words that
 * merely *look* like Base64 fall through.
 * @param {string} text
 * @returns {InternalStep | undefined}
 */
function detectBase64(text) {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 8) return undefined;
  const isStandard = /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
  const isUrlSafe = !isStandard && /[-_]/.test(compact) && /^[A-Za-z0-9_-]+={0,2}$/.test(compact);
  if (!isStandard && !isUrlSafe) return undefined;
  const bytes = decodeBase64Bytes(compact, isUrlSafe);
  if (!bytes) return undefined;
  return stepFromBytes("base64", isUrlSafe ? "Base64 (URL-safe)" : "Base64", bytes);
}

/**
 * Terminal formatting step: valid but unformatted JSON gets pretty-printed.
 * @param {string} text
 * @returns {InternalStep | undefined}
 */
function detectCompactJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const pretty = JSON.stringify(parsed, null, 2);
  if (pretty === text) return undefined;
  return {
    kind: "json",
    label: "Formatted JSON",
    text: pretty,
    isBinary: false,
    next: undefined,
  };
}

/** Ordered text detectors — first match wins. */
const TEXT_DETECTORS = [
  detectDataUrl,
  detectJwt,
  detectPem,
  detectQuotedString,
  detectEscapedText,
  detectUrlEncoded,
  detectHex,
  detectBase64,
  detectCompactJson,
];

/* ------------------------------ the pipeline ----------------------------- */

/**
 * Run the ordered detectors against one piece of text.
 * @param {string} text
 * @returns {InternalStep | undefined}
 */
function decodeTextStep(text) {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  for (const detect of TEXT_DETECTORS) {
    const step = detect(trimmed);
    if (step) return step;
  }
  return undefined;
}

/**
 * Decompress bytes with the built-in DecompressionStream.
 * @param {Uint8Array} bytes
 * @param {"gzip" | "deflate"} format
 * @returns {Promise<Uint8Array>}
 */
async function decompressBytes(bytes, format) {
  // Copy into a fresh, ArrayBuffer-backed view so Blob accepts it.
  const stream = new Blob([new Uint8Array(bytes)]).stream()
    .pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Handle a bytes state — only ever reached for gzip/zlib-classified buffers.
 * Decompressed output is always accepted: the magic bytes proved intent.
 * @param {Uint8Array} bytes
 * @returns {Promise<InternalStep | undefined>}
 */
async function decodeBytesStep(bytes) {
  const classified = classifyBytes(bytes);
  if (classified.type !== "gzip" && classified.type !== "zlib") return undefined;
  let inflated;
  try {
    inflated = await decompressBytes(bytes, classified.type === "gzip" ? "gzip" : "deflate");
  } catch {
    return undefined;
  }
  const label = classified.type === "gzip" ? "Gzip" : "Zlib (deflate)";
  return stepFromBytes(classified.type, label, inflated, { acceptUnknown: true });
}

/**
 * Decode an opaque input, one detected layer at a time, until nothing more
 * applies, a terminal step is reached, or {@link MAX_STEPS} unwraps happened.
 * @param {string} input
 * @returns {Promise<DecodeResult>}
 */
export async function decodeAll(input) {
  /** @type {DecodeStep[]} */
  const steps = [];
  /** @type {{ text?: string, bytes?: Uint8Array }} */
  let current = { text: String(input ?? "") };

  while (steps.length < MAX_STEPS) {
    /** @type {InternalStep | undefined} */
    const step = current.bytes !== undefined
      ? await decodeBytesStep(current.bytes)
      : decodeTextStep(current.text ?? "");
    if (!step) break;
    steps.push({
      kind: step.kind,
      label: step.label,
      text: step.text,
      note: step.note,
      isBinary: step.isBinary,
      bytes: step.bytes,
    });
    if (!step.next) break;
    current = step.next;
  }

  return { steps, final: steps[steps.length - 1] };
}
