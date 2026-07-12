/**
 * Tests for the Encode-mode chain. The strongest property is parity with the
 * decoder: whatever the encoder produces, `decodeAll` must unwrap back to the
 * original text. Run with `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import { decodeAll } from "../static/decode/decode.mjs";
import { encodeBase64Bytes, encodeChain, encoderFor, ENCODERS } from "../static/decode/encode.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

async function roundtrip(text: string, kinds: string[]): Promise<void> {
  const encoded = await encodeChain(text, kinds);
  const decoded = await decodeAll(encoded.final);
  assertEquals(
    decoded.final?.text,
    text,
    `decodeAll must invert encodeChain(${JSON.stringify(kinds)})`,
  );
}

Deno.test("encodeChain: empty input yields no steps", async () => {
  assertEquals(await encodeChain("", ["base64"]), { steps: [], final: "" });
});

Deno.test("encodeChain: unknown kinds throw", async () => {
  let threw = false;
  try {
    await encodeChain("x", ["rot13"]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("encodeChain: records one step per layer, in order", async () => {
  const result = await encodeChain("hi", ["base64", "url"]);
  assertEquals(result.steps.map((step: { kind: string }) => step.kind), ["base64", "url"]);
  assertEquals(result.final, result.steps[1].text);
});

Deno.test("encodeBase64Bytes: URL-safe variant maps chars and strips padding", () => {
  const bytes = new Uint8Array([251, 255, 190]); // "+/" territory in standard Base64
  assertEquals(encodeBase64Bytes(bytes, false), "+/++");
  assertEquals(encodeBase64Bytes(bytes, true), "-_--");
  assertEquals(encodeBase64Bytes(new Uint8Array([104, 105]), true), "aGk");
});

Deno.test("parity: Base64 roundtrips through the decoder (incl. unicode)", async () => {
  await roundtrip("hello wörld ✓ — payload", ["base64"]);
});

Deno.test("parity: URL-safe Base64 roundtrips through the decoder", async () => {
  await roundtrip("subject?query=a b&lang=dé", ["base64url"]);
});

Deno.test("parity: hex roundtrips through the decoder", async () => {
  await roundtrip("hello world!", ["hex"]);
});

Deno.test("parity: URL percent-encoding roundtrips through the decoder", async () => {
  await roundtrip("redirect=https://portal.example.ch/cb?state=x y", ["url"]);
});

Deno.test("parity: gzip + Base64 roundtrips through the decoder", async () => {
  await roundtrip(
    "The quick brown fox jumps over the lazy dog. ".repeat(4),
    ["gzip-base64"],
  );
});

Deno.test("parity: JSON escaping roundtrips through the decoder", async () => {
  await roundtrip('request={"logonId":"L006344"}', ["escaped"]);
});

Deno.test("parity: stacked layers unwrap in reverse order", async () => {
  await roundtrip("layer cake with spaces & symbols ✓", ["url", "base64"]);
  await roundtrip("double wrapped", ["base64", "base64"]);
});

Deno.test("encoderFor: resolves every advertised encoder", () => {
  for (const encoder of ENCODERS) {
    assertEquals(encoderFor(encoder.kind)?.label, encoder.label);
  }
  assertEquals(encoderFor("nope"), undefined);
});
