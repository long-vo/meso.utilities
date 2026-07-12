// @ts-check
/**
 * JWT verification for Decode Anything. Verifies HS/RS/PS/ES signatures with
 * WebCrypto against a pasted HMAC secret or a pasted JWK / JWKS JSON, and
 * explains the time claims (exp / nbf / iat) in human terms. Everything runs
 * locally — the token and key never leave the page.
 *
 * The module is dependency-free and isomorphic: the browser imports it for the
 * live UI and the Deno tests import the very same file.
 */
import { decodeBase64Bytes } from "./decode.mjs";

/**
 * @typedef {Object} JwtParts
 * @property {Record<string, unknown>} header
 * @property {Record<string, unknown>} payload
 * @property {string} signingInput the `header.payload` text that was signed
 * @property {string} signaturePart Base64url signature segment ("" when absent)
 */

/**
 * Split and parse a compact JWT. Returns undefined when it is not one.
 * @param {string} token
 * @returns {JwtParts | undefined}
 */
export function decodeJwtParts(token) {
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)$/.exec(token.trim());
  if (!match) return undefined;
  const [, headerPart, payloadPart, signaturePart] = match;
  const header = parseSegment(headerPart);
  const payload = parseSegment(payloadPart);
  if (!header || typeof header.alg !== "string" || !payload) return undefined;
  return { header, payload, signingInput: `${headerPart}.${payloadPart}`, signaturePart };
}

/**
 * @param {string} segment
 * @returns {Record<string, unknown> | undefined}
 */
function parseSegment(segment) {
  const bytes = decodeBase64Bytes(segment, true);
  if (!bytes) return undefined;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? /** @type {Record<string, unknown>} */ (value)
      : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------- time claims ------------------------------ */

/**
 * @param {number} ms absolute difference in milliseconds
 * @returns {string}
 */
function humanizeMs(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 365) return `${days} d`;
  return `${Math.round(days / 365)} y`;
}

/**
 * @typedef {Object} JwtTime
 * @property {"exp" | "nbf" | "iat"} claim
 * @property {string} iso the claim as an ISO timestamp
 * @property {string} relative e.g. "expires in 3 d", "issued 5 min ago"
 * @property {"ok" | "bad" | "info"} status colour hint for the UI
 */

/**
 * Describe the time claims of a JWT payload relative to `nowMs`.
 * @param {Record<string, unknown>} payload
 * @param {number} [nowMs]
 * @returns {JwtTime[]}
 */
export function describeJwtTimes(payload, nowMs = Date.now()) {
  /** @type {JwtTime[]} */
  const times = [];
  const exp = numberClaim(payload.exp);
  if (exp !== undefined) {
    const isPast = exp < nowMs;
    times.push({
      claim: "exp",
      iso: new Date(exp).toISOString(),
      relative: isPast
        ? `expired ${humanizeMs(nowMs - exp)} ago`
        : `expires in ${humanizeMs(exp - nowMs)}`,
      status: isPast ? "bad" : "ok",
    });
  }
  const nbf = numberClaim(payload.nbf);
  if (nbf !== undefined) {
    const isFuture = nbf > nowMs;
    times.push({
      claim: "nbf",
      iso: new Date(nbf).toISOString(),
      relative: isFuture
        ? `not valid for another ${humanizeMs(nbf - nowMs)}`
        : `valid since ${humanizeMs(nowMs - nbf)} ago`,
      status: isFuture ? "bad" : "ok",
    });
  }
  const iat = numberClaim(payload.iat);
  if (iat !== undefined) {
    times.push({
      claim: "iat",
      iso: new Date(iat).toISOString(),
      relative: iat <= nowMs
        ? `issued ${humanizeMs(nowMs - iat)} ago`
        : `issued ${humanizeMs(iat - nowMs)} in the future`,
      status: "info",
    });
  }
  return times;
}

/**
 * NumericDate claim (seconds) → milliseconds, or undefined.
 * @param {unknown} value
 * @returns {number | undefined}
 */
function numberClaim(value) {
  return typeof value === "number" && Number.isFinite(value) ? value * 1000 : undefined;
}

/* ------------------------------ verification ------------------------------ */

/** @type {Record<string, { hash: string, params: (sig: Uint8Array) => AlgorithmIdentifier | RsaPssParams | EcdsaParams, importParams: RsaHashedImportParams | EcKeyImportParams | { name: string, hash: string }, keyKind: "hmac" | "rsa" | "ec" }>} */
const ALGORITHMS = {
  HS256: hmacAlg("SHA-256"),
  HS384: hmacAlg("SHA-384"),
  HS512: hmacAlg("SHA-512"),
  RS256: rsaAlg("RSASSA-PKCS1-v1_5", "SHA-256"),
  RS384: rsaAlg("RSASSA-PKCS1-v1_5", "SHA-384"),
  RS512: rsaAlg("RSASSA-PKCS1-v1_5", "SHA-512"),
  PS256: pssAlg("SHA-256", 32),
  PS384: pssAlg("SHA-384", 48),
  PS512: pssAlg("SHA-512", 64),
  ES256: ecAlg("P-256", "SHA-256"),
  ES384: ecAlg("P-384", "SHA-384"),
  ES512: ecAlg("P-521", "SHA-512"),
};

/** @param {string} hash */
function hmacAlg(hash) {
  return {
    hash,
    params: () => ({ name: "HMAC" }),
    importParams: { name: "HMAC", hash },
    keyKind: /** @type {const} */ ("hmac"),
  };
}

/** @param {string} name @param {string} hash */
function rsaAlg(name, hash) {
  return {
    hash,
    params: () => ({ name }),
    importParams: /** @type {RsaHashedImportParams} */ ({ name, hash }),
    keyKind: /** @type {const} */ ("rsa"),
  };
}

/** @param {string} hash @param {number} saltLength */
function pssAlg(hash, saltLength) {
  return {
    hash,
    params: () => /** @type {RsaPssParams} */ ({ name: "RSA-PSS", saltLength }),
    importParams: /** @type {RsaHashedImportParams} */ ({ name: "RSA-PSS", hash }),
    keyKind: /** @type {const} */ ("rsa"),
  };
}

/** @param {string} curve @param {string} hash */
function ecAlg(curve, hash) {
  return {
    hash,
    params: () => /** @type {EcdsaParams} */ ({ name: "ECDSA", hash }),
    importParams: /** @type {EcKeyImportParams} */ ({ name: "ECDSA", namedCurve: curve }),
    keyKind: /** @type {const} */ ("ec"),
  };
}

/**
 * Pick the JWK to verify with: an explicit JWKS is matched by `kid` (or the
 * first signature key), a single JWK object is used as-is.
 * @param {unknown} parsed
 * @param {Record<string, unknown>} header
 * @returns {Record<string, unknown> | undefined}
 */
function selectJwk(parsed, header) {
  if (parsed === null || typeof parsed !== "object") return undefined;
  const container = /** @type {Record<string, unknown>} */ (parsed);
  if (!Array.isArray(container.keys)) {
    return typeof container.kty === "string" ? container : undefined;
  }
  const keys = container.keys.filter((key) => key !== null && typeof key === "object");
  if (typeof header.kid === "string") {
    const byKid = keys.find((key) =>
      /** @type {Record<string, unknown>} */ (key).kid === header.kid
    );
    if (byKid) return /** @type {Record<string, unknown>} */ (byKid);
  }
  return /** @type {Record<string, unknown> | undefined} */ (keys[0]);
}

/**
 * @typedef {Object} JwtVerification
 * @property {boolean} ok signature verified
 * @property {string} [alg] the token's algorithm
 * @property {string} [reason] why verification failed or was impossible
 */

/**
 * Verify a JWT's signature against `keyText` — an HMAC secret for HS*, or a
 * pasted JWK / JWKS JSON for RS* / PS* / ES*.
 * @param {string} token
 * @param {string} keyText
 * @returns {Promise<JwtVerification>}
 */
export async function verifyJwtSignature(token, keyText) {
  const parts = decodeJwtParts(token);
  if (!parts) return { ok: false, reason: "not a decodable JWT" };
  const alg = String(parts.header.alg);
  if (alg.toLowerCase() === "none") {
    return { ok: false, alg, reason: 'alg "none" has no signature to verify' };
  }
  const algorithm = ALGORITHMS[alg];
  if (!algorithm) return { ok: false, alg, reason: `unsupported algorithm ${alg}` };
  if (parts.signaturePart === "") return { ok: false, alg, reason: "the token has no signature" };
  const signature = decodeBase64Bytes(parts.signaturePart, true);
  if (!signature) return { ok: false, alg, reason: "the signature is not valid Base64url" };

  const trimmedKey = keyText.trim();
  if (trimmedKey === "") {
    return {
      ok: false,
      alg,
      reason: algorithm.keyKind === "hmac"
        ? "paste the shared secret to verify"
        : "paste the public key as JWK / JWKS JSON to verify",
    };
  }

  /** @type {CryptoKey} */
  let key;
  try {
    if (trimmedKey.startsWith("{")) {
      const jwk = selectJwk(JSON.parse(trimmedKey), parts.header);
      if (!jwk) return { ok: false, alg, reason: "no usable key in the pasted JWK / JWKS" };
      key = await crypto.subtle.importKey(
        "jwk",
        /** @type {JsonWebKey} */ (jwk),
        algorithm.importParams,
        false,
        ["verify"],
      );
    } else if (algorithm.keyKind === "hmac") {
      key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(trimmedKey),
        algorithm.importParams,
        false,
        ["verify"],
      );
    } else {
      return { ok: false, alg, reason: `${alg} needs a public key as JWK / JWKS JSON` };
    }
  } catch (error) {
    return { ok: false, alg, reason: `key not usable: ${describeError(error)}` };
  }

  try {
    const ok = await crypto.subtle.verify(
      algorithm.params(signature),
      key,
      /** @type {BufferSource} */ (new Uint8Array(signature)),
      new TextEncoder().encode(parts.signingInput),
    );
    return ok ? { ok: true, alg } : { ok: false, alg, reason: "signature does not match" };
  } catch (error) {
    return { ok: false, alg, reason: `verification failed: ${describeError(error)}` };
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
