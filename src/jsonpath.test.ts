/**
 * Tests for the JSON-path extraction behind "capture into variable". Run with
 * `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import { extractJsonPath, parseJsonPath, variableStringFor } from "../static/rest/jsonpath.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

const ROOT = {
  access_token: "tok-1",
  data: {
    items: [{ id: 7, tags: ["a", "b"] }, { id: 8 }],
    "key with spaces": true,
  },
};

Deno.test("parseJsonPath: the everyday shapes", () => {
  assertEquals(parseJsonPath("$.a.b"), { segments: ["a", "b"] });
  assertEquals(parseJsonPath("a.b"), { segments: ["a", "b"] });
  assertEquals(parseJsonPath("$"), { segments: [] });
  assertEquals(parseJsonPath("$.items[0].id"), { segments: ["items", 0, "id"] });
  assertEquals(parseJsonPath(`$['key with spaces']`), { segments: ["key with spaces"] });
  assertEquals(parseJsonPath(`$["quoted"]`), { segments: ["quoted"] });
  assertEquals("error" in parseJsonPath(""), true);
  assertEquals("error" in parseJsonPath("$.a..b"), true);
  assertEquals("error" in parseJsonPath("$.a[b]"), true);
});

Deno.test("extractJsonPath: walks objects, arrays and quoted keys", () => {
  assertEquals(extractJsonPath(ROOT, "$.access_token"), { ok: true, value: "tok-1" });
  assertEquals(extractJsonPath(ROOT, "access_token"), { ok: true, value: "tok-1" });
  assertEquals(extractJsonPath(ROOT, "$.data.items[1].id"), { ok: true, value: 8 });
  assertEquals(extractJsonPath(ROOT, "$.data.items[0].tags[1]"), { ok: true, value: "b" });
  assertEquals(extractJsonPath(ROOT, `$.data['key with spaces']`), { ok: true, value: true });
  assertEquals(extractJsonPath(ROOT, "$"), { ok: true, value: ROOT });
});

Deno.test("extractJsonPath: explains what went wrong", () => {
  const missing = extractJsonPath(ROOT, "$.data.nope");
  assertEquals(missing.ok, false);
  assertEquals(!missing.ok && missing.error.includes('"nope"'), true);

  const outOfRange = extractJsonPath(ROOT, "$.data.items[9]");
  assertEquals(!outOfRange.ok && outOfRange.error.includes("out of range"), true);

  const wrongType = extractJsonPath(ROOT, "$.access_token[0]");
  assertEquals(!wrongType.ok && wrongType.error.includes("non-array"), true);

  const keyOnArray = extractJsonPath(ROOT, "$.data.items.id");
  assertEquals(!keyOnArray.ok && keyOnArray.error.includes("non-object"), true);
});

Deno.test("variableStringFor: strings stay raw, everything else becomes JSON", () => {
  assertEquals(variableStringFor("tok"), "tok");
  assertEquals(variableStringFor(42), "42");
  assertEquals(variableStringFor(true), "true");
  assertEquals(variableStringFor(null), "null");
  assertEquals(variableStringFor({ a: 1 }), '{"a":1}');
  assertEquals(variableStringFor(["x"]), '["x"]');
});
