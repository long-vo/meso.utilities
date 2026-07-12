/**
 * Tests for JWT verification. Tokens are signed in-test with WebCrypto so the
 * verifier is checked against real HS256 / RS256 / ES256 signatures. Run with
 * `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import { decodeJwtParts, describeJwtTimes, verifyJwtSignature } from "../static/decode/jwt.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signedJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  sign: (data: Uint8Array) => Promise<ArrayBuffer>,
): Promise<string> {
  const input = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = new Uint8Array(await sign(new TextEncoder().encode(input)));
  return `${input}.${b64url(signature)}`;
}

async function hs256Jwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return signedJwt(
    { alg: "HS256", typ: "JWT" },
    payload,
    (data) => crypto.subtle.sign("HMAC", key, data as BufferSource),
  );
}

const PAYLOAD = { sub: "L006344", tenant: "baloise-id" };

Deno.test("decodeJwtParts: parses header, payload and signing input", async () => {
  const token = await hs256Jwt(PAYLOAD, "s3cret");
  const parts = decodeJwtParts(token);
  assertEquals(parts?.header.alg, "HS256");
  assertEquals(parts?.payload.sub, "L006344");
  assertEquals(token.startsWith(parts?.signingInput ?? "!"), true);
});

Deno.test("decodeJwtParts: rejects non-JWTs", () => {
  assertEquals(decodeJwtParts("not a token"), undefined);
  assertEquals(decodeJwtParts("a.b.c"), undefined);
});

Deno.test("verify: HS256 round-trip — right secret ok, wrong secret not", async () => {
  const token = await hs256Jwt(PAYLOAD, "s3cret");
  assertEquals(await verifyJwtSignature(token, "s3cret"), { ok: true, alg: "HS256" });
  const wrong = await verifyJwtSignature(token, "nope");
  assertEquals(wrong.ok, false);
  assertEquals(wrong.reason, "signature does not match");
});

Deno.test("verify: a tampered payload fails", async () => {
  const token = await hs256Jwt(PAYLOAD, "s3cret");
  const [header, , signature] = token.split(".");
  const forged = `${header}.${b64urlJson({ ...PAYLOAD, sub: "ADMIN" })}.${signature}`;
  assertEquals((await verifyJwtSignature(forged, "s3cret")).ok, false);
});

Deno.test("verify: refuses alg none and empty keys with clear reasons", async () => {
  const none = `${b64urlJson({ alg: "none" })}.${b64urlJson(PAYLOAD)}.`;
  const noneResult = await verifyJwtSignature(none, "anything");
  assertEquals(noneResult.ok, false);
  assertEquals(noneResult.reason?.includes("none"), true);

  const token = await hs256Jwt(PAYLOAD, "s3cret");
  const empty = await verifyJwtSignature(token, "   ");
  assertEquals(empty.ok, false);
  assertEquals(empty.reason?.includes("secret"), true);
});

Deno.test("verify: RS256 via a pasted JWK, and JWKS selection by kid", async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const token = await signedJwt(
    { alg: "RS256", kid: "k1" },
    PAYLOAD,
    (data) => crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, data as BufferSource),
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);

  assertEquals(await verifyJwtSignature(token, JSON.stringify(jwk)), { ok: true, alg: "RS256" });
  const jwks = { keys: [{ kty: "oct", kid: "other" }, { ...jwk, kid: "k1" }] };
  assertEquals(await verifyJwtSignature(token, JSON.stringify(jwks)), { ok: true, alg: "RS256" });

  const secretInstead = await verifyJwtSignature(token, "plain secret");
  assertEquals(secretInstead.ok, false);
  assertEquals(secretInstead.reason?.includes("JWK"), true);
});

Deno.test("verify: ES256 via a pasted JWK", async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const token = await signedJwt(
    { alg: "ES256" },
    PAYLOAD,
    (data) =>
      crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, data as BufferSource),
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  assertEquals(await verifyJwtSignature(token, JSON.stringify(jwk)), { ok: true, alg: "ES256" });
});

Deno.test("describeJwtTimes: exp / nbf / iat with statuses", () => {
  const now = 1_750_000_000_000;
  const second = 1000;
  const times = describeJwtTimes(
    {
      exp: (now - 3 * second) / 1000,
      nbf: (now + 60 * second) / 1000,
      iat: (now - 60 * second) / 1000,
    },
    now,
  );
  assertEquals(times.map((t: { claim: string }) => t.claim), ["exp", "nbf", "iat"]);
  assertEquals(times[0].status, "bad");
  assertEquals(times[0].relative.includes("expired"), true);
  assertEquals(times[1].status, "bad");
  assertEquals(times[2].status, "info");

  const valid = describeJwtTimes({ exp: (now + 3600 * second) / 1000 }, now);
  assertEquals(valid[0].status, "ok");
  assertEquals(valid[0].relative.includes("expires in"), true);

  assertEquals(describeJwtTimes({}, now), []);
});
