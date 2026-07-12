// @ts-check
/**
 * Encode-mode logic for Decode Anything: the reverse pipeline. Wraps plain
 * text in encoding layers — Base64 (standard and URL-safe), hex, URL
 * percent-encoding, gzip+Base64 and JSON escaping — one layer at a time, in
 * the order the user stacked them.
 *
 * The module is dependency-free and isomorphic: the browser imports it for the
 * live UI and the Deno tests import the very same file.
 */

/**
 * @typedef {Object} EncodeStep
 * @property {string} kind machine-readable layer type (matches a decoder kind)
 * @property {string} label human-readable layer name shown in the UI
 * @property {string} text the value after this layer was applied
 */

/**
 * @typedef {Object} EncodeResult
 * @property {EncodeStep[]} steps applied layers, in order
 * @property {string} final the fully encoded value ("" for empty input)
 */

/** Encode bytes as Base64, chunked so large buffers don't blow the stack. */
/**
 * @param {Uint8Array} bytes
 * @param {boolean} isUrlSafe
 * @returns {string}
 */
export function encodeBase64Bytes(bytes, isUrlSafe) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const standard = btoa(binary);
  return isUrlSafe ? standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : standard;
}

/**
 * Compress bytes with the built-in CompressionStream.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function gzipBytes(bytes) {
  const stream = new Blob([new Uint8Array(bytes)]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** @param {string} text @returns {Uint8Array} */
function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}

/**
 * Available layers, in menu order. Kinds intentionally mirror the decoder's
 * step kinds, so an encoded chain reads like a decode chain in reverse.
 * @type {{ kind: string, label: string, apply: (text: string) => string | Promise<string> }[]}
 */
export const ENCODERS = [
  {
    kind: "base64",
    label: "Base64",
    apply: (text) => encodeBase64Bytes(utf8Bytes(text), false),
  },
  {
    kind: "base64url",
    label: "Base64 (URL-safe)",
    apply: (text) => encodeBase64Bytes(utf8Bytes(text), true),
  },
  {
    kind: "hex",
    label: "Hex",
    apply: (text) =>
      [...utf8Bytes(text)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  },
  {
    kind: "url",
    label: "URL percent-encoding",
    apply: (text) => encodeURIComponent(text),
  },
  {
    kind: "gzip-base64",
    label: "gzip + Base64",
    apply: async (text) => encodeBase64Bytes(await gzipBytes(utf8Bytes(text)), false),
  },
  {
    kind: "escaped",
    label: "JSON-escaped text",
    apply: (text) => JSON.stringify(text).slice(1, -1),
  },
];

/**
 * Look up an encoder by kind.
 * @param {string} kind
 */
export function encoderFor(kind) {
  return ENCODERS.find((encoder) => encoder.kind === kind);
}

/**
 * Apply a stack of encoder kinds to the input, innermost first — the order
 * the user clicked them. Unknown kinds throw (a programming error, not bad
 * user input).
 * @param {string} input
 * @param {string[]} kinds
 * @returns {Promise<EncodeResult>}
 */
export async function encodeChain(input, kinds) {
  /** @type {EncodeStep[]} */
  const steps = [];
  let current = String(input ?? "");
  if (current === "") return { steps, final: "" };
  for (const kind of kinds) {
    const encoder = encoderFor(kind);
    if (!encoder) throw new Error(`unknown encoder kind: ${kind}`);
    current = await encoder.apply(current);
    steps.push({ kind: encoder.kind, label: encoder.label, text: current });
  }
  return { steps, final: current };
}
