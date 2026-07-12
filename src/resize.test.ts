/**
 * Tests for the controls-sidebar resize logic. Run with `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import {
  clampWidth,
  DEFAULT_WIDTH,
  MAX_WIDTH,
  MIN_WIDTH,
  storageKey,
  toolKey,
} from "../static/resize.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

Deno.test("clampWidth: keeps in-range values (rounded to whole pixels)", () => {
  assertEquals(clampWidth(320), 320);
  assertEquals(clampWidth(MIN_WIDTH), MIN_WIDTH);
  assertEquals(clampWidth(MAX_WIDTH), MAX_WIDTH);
  assertEquals(clampWidth(401.6), 402);
});

Deno.test("clampWidth: clamps below MIN and above MAX", () => {
  assertEquals(clampWidth(MIN_WIDTH - 100), MIN_WIDTH, "below the floor");
  assertEquals(clampWidth(MAX_WIDTH + 100), MAX_WIDTH, "above the ceiling");
  assertEquals(clampWidth(-9999), MIN_WIDTH);
});

Deno.test("clampWidth: parses numeric strings from localStorage", () => {
  assertEquals(clampWidth("420"), 420);
  assertEquals(clampWidth("240"), MIN_WIDTH);
});

Deno.test("clampWidth: non-numeric input falls back to the default", () => {
  assertEquals(clampWidth("not-a-number"), DEFAULT_WIDTH);
  assertEquals(clampWidth(undefined), DEFAULT_WIDTH);
  assertEquals(clampWidth(NaN), DEFAULT_WIDTH);
  assertEquals(clampWidth(Infinity), DEFAULT_WIDTH);
});

Deno.test("toolKey: derives the folder name from a pathname", () => {
  assertEquals(toolKey("/sanitize/"), "sanitize");
  assertEquals(toolKey("/decode/"), "decode");
  assertEquals(toolKey("/rest/index.html"), "rest");
  assertEquals(toolKey("/meso.utilities/rest/"), "rest", "GitHub Pages project sub-path");
  assertEquals(toolKey("/"), "root", "hub / root has no tool folder");
});

Deno.test("storageKey: one namespaced key per tool", () => {
  assertEquals(storageKey("/sanitize/"), "meso-controls-w-sanitize");
  assertEquals(storageKey("/decode/index.html"), "meso-controls-w-decode");
  assertEquals(storageKey("/meso.utilities/rest/"), "meso-controls-w-rest");
});
