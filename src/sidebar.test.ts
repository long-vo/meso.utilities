/**
 * Tests for the controls-sidebar show/hide logic. Run with `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import { parseHidden, serializeHidden, storageKey } from "../static/sidebar.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

Deno.test("storageKey: one namespaced key per tool, distinct from the width key", () => {
  assertEquals(storageKey("/sanitize/"), "meso-controls-hidden-sanitize");
  assertEquals(storageKey("/decode/index.html"), "meso-controls-hidden-decode");
  assertEquals(storageKey("/meso.utilities/rest/"), "meso-controls-hidden-rest");
});

Deno.test("serializeHidden: maps the flag to the stored string", () => {
  assertEquals(serializeHidden(true), "1");
  assertEquals(serializeHidden(false), "0");
});

Deno.test('parseHidden: only "1" is hidden; everything else is shown', () => {
  assertEquals(parseHidden("1"), true);
  assertEquals(parseHidden("0"), false);
  assertEquals(parseHidden(""), false, "empty string");
  assertEquals(parseHidden("true"), false, "legacy/other values are not hidden");
  assertEquals(parseHidden(null), false, "missing value");
});

Deno.test("serialize/parse round-trip", () => {
  assertEquals(parseHidden(serializeHidden(true)), true);
  assertEquals(parseHidden(serializeHidden(false)), false);
});
