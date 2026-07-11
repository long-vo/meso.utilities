/**
 * Tests for the Decode Anything detection pipeline. Run with `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import { classifyBytes, decodeAll, isReadableText } from "../static/decode/decode.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

function assertContains(haystack: string | undefined, needle: string, msg?: string): void {
  if (haystack === undefined || !haystack.includes(needle)) {
    throw new Error(`${msg ?? "assertContains failed"}\n  needle: ${needle}\n  in: ${haystack}`);
  }
}

async function kindsOf(input: string): Promise<string[]> {
  return (await decodeAll(input)).steps.map((step) => step.kind);
}

function base64Url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function compressBase64(text: string, format: "gzip" | "deflate"): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream(format));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* ------------------------------ single layers ----------------------------- */

Deno.test("base64: standard alphabet decodes to text", async () => {
  const result = await decodeAll("aGVsbG8gd29ybGQ=");
  assertEquals(result.steps.length, 1);
  assertEquals(result.steps[0].kind, "base64");
  assertEquals(result.final?.text, "hello world");
});

Deno.test("base64: URL-safe alphabet is recognised", async () => {
  const result = await decodeAll("Pj4-Pz8_");
  assertEquals(result.steps[0].label, "Base64 (URL-safe)");
  assertEquals(result.final?.text, ">>>???");
});

Deno.test("base64: whitespace/newlines inside the blob are ignored", async () => {
  const result = await decodeAll("aGVsbG8g\nd29y\nbGQ=");
  assertEquals(result.final?.text, "hello world");
});

Deno.test("hex: plain, 0x-prefixed and spaced forms decode", async () => {
  assertEquals((await decodeAll("48656c6c6f2c20776f726c6421")).final?.text, "Hello, world!");
  assertEquals((await decodeAll("0x48 65 6c 6c 6f")).final?.text, "Hello");
  assertEquals((await decodeAll("48:65:6c:6c:6f")).final?.text, "Hello");
});

Deno.test("url: percent-encoding decodes and chains into JSON formatting", async () => {
  const result = await decodeAll("%7B%22a%22%3A1%7D");
  assertEquals(await kindsOf("%7B%22a%22%3A1%7D"), ["url", "json"]);
  assertEquals(result.final?.text, '{\n  "a": 1\n}');
});

Deno.test("escaped: stringified log JSON is unescaped, then formatted", async () => {
  const input = String.raw`{\"reqCtx\":{\"logonId\":\"L006344\"},\"avaloqPersId\":7483881}`;
  assertEquals(await kindsOf(input), ["escaped", "json"]);
  assertContains((await decodeAll(input)).final?.text, '"logonId": "L006344"');
});

Deno.test("quoted string: JSON string literal is unwrapped and keeps chaining", async () => {
  const result = await decodeAll('"aGVsbG8gd29ybGQ="');
  assertEquals(result.steps.map((step) => step.kind), ["json-string", "base64"]);
  assertEquals(result.final?.text, "hello world");
});

Deno.test("json: compact JSON is pretty-printed as a terminal step", async () => {
  const result = await decodeAll('{"a":{"b":[1,2]}}');
  assertEquals(result.steps.length, 1);
  assertEquals(result.steps[0].kind, "json");
  assertContains(result.final?.text, '"b": [');
});

Deno.test("data url: base64 payload is unwrapped", async () => {
  const result = await decodeAll("data:text/plain;base64,SGVsbG8sIHdvcmxkIQ==");
  assertEquals(result.steps[0].kind, "data-url");
  assertEquals(result.final?.text, "Hello, world!");
});

/* -------------------------------- layered -------------------------------- */

Deno.test("chain: double base64 unwraps twice", async () => {
  const twice = btoa("aGVsbG8gd29ybGQ=");
  const result = await decodeAll(twice);
  assertEquals(result.steps.length, 2);
  assertEquals(result.final?.text, "hello world");
});

Deno.test("chain: base64 → gzip → formatted JSON", async () => {
  const input = await compressBase64('{"logonId":"L006344"}', "gzip");
  assertEquals(await kindsOf(input), ["base64", "gzip", "json"]);
  const result = await decodeAll(input);
  assertContains(result.steps[0].note, "gzip-compressed");
  assertContains(result.final?.text, '"logonId": "L006344"');
});

Deno.test("chain: hex → zlib → text", async () => {
  const compressed = await compressBase64("plain text payload", "deflate");
  const bytes = Uint8Array.from(atob(compressed), (c) => c.charCodeAt(0));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const result = await decodeAll(hex);
  assertEquals(result.steps.map((step) => step.kind), ["hex", "zlib"]);
  assertEquals(result.final?.text, "plain text payload");
});

/* ---------------------------------- JWT ----------------------------------- */

Deno.test("jwt: header and payload are decoded, signature left unverified", async () => {
  const token = `${base64Url('{"alg":"HS256","typ":"JWT"}')}.${
    base64Url('{"sub":"L006344","exp":4102444800}')
  }.abc123`;
  const result = await decodeAll(token);
  assertEquals(result.steps.length, 1);
  assertEquals(result.steps[0].kind, "jwt");
  assertContains(result.final?.text, '"sub": "L006344"');
  assertContains(result.steps[0].note, "alg HS256");
  assertContains(result.steps[0].note, "expires 2100-01-01");
  assertContains(result.steps[0].note, "signature not verified");
});

Deno.test("jwt: expired tokens are flagged", async () => {
  const token = `${base64Url('{"alg":"RS256"}')}.${base64Url('{"exp":1000000000}')}.sig`;
  const result = await decodeAll(token);
  assertContains(result.steps[0].note, "expired 2001-09-09");
});

/* ---------------------------------- PEM ----------------------------------- */

Deno.test("pem: armored DER body decodes to a binary step", async () => {
  const der = new Uint8Array([0x30, 0x82, 0x01, 0x0a, 0x02, 0x82, 0x01, 0x01, 0x00, 0xc4]);
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const pem = `-----BEGIN CERTIFICATE-----\n${btoa(binary)}\n-----END CERTIFICATE-----`;
  const result = await decodeAll(pem);
  assertEquals(result.steps.length, 1);
  assertEquals(result.steps[0].kind, "pem");
  assertEquals(result.steps[0].isBinary, true);
  assertContains(result.steps[0].note, "DER / ASN.1");
});

/* ---------------------------- false positives ----------------------------- */

Deno.test("plain text is never mangled", async () => {
  for (
    const input of [
      "Hello, world",
      "password",
      "deadbeef",
      "12345678",
      "C:\\Users\\temp\\report.txt",
      "550e8400-e29b-41d4-a716-446655440000",
      "2026-07-11 04:12:39.550 INFO nothing encoded here",
    ]
  ) {
    assertEquals(await kindsOf(input), [], `expected no decode for: ${input}`);
  }
});

Deno.test("already-pretty JSON needs no step", async () => {
  const pretty = '{\n  "a": 1\n}';
  assertEquals(await kindsOf(pretty), []);
});

Deno.test("empty input decodes to nothing", async () => {
  const result = await decodeAll("");
  assertEquals(result.steps.length, 0);
  assertEquals(result.final, undefined);
});

/* -------------------------------- helpers --------------------------------- */

Deno.test("isReadableText: rejects control characters, keeps unicode", () => {
  assertEquals(isReadableText("héllo wörld\n\ttabbed"), true);
  assertEquals(isReadableText("bad\u0000byte"), false);
  assertEquals(isReadableText(""), false);
});

Deno.test("classifyBytes: spots gzip, zlib, text and signatures", () => {
  assertEquals(classifyBytes(new Uint8Array([0x1f, 0x8b, 0x08])).type, "gzip");
  assertEquals(classifyBytes(new Uint8Array([0x78, 0x9c, 0x01])).type, "zlib");
  assertEquals(classifyBytes(new TextEncoder().encode("readable")).type, "text");
  // PNG magic — unlike %PDF it is not printable ASCII, so it cannot be text.
  assertEquals(classifyBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d])).type, "signature");
  assertEquals(classifyBytes(new Uint8Array([0xde, 0xad, 0xbe, 0xef])).type, "unknown");
});
