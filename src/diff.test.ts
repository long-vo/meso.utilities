/**
 * Tests for the line-pair diff used by the Sanitize JSON diff view. Run with
 * `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import { changedCount, pairLineDiff } from "../static/diff.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

Deno.test("pairLineDiff: identical texts produce no changed rows", () => {
  const rows = pairLineDiff("a\nb\nc", "a\nb\nc");
  assertEquals(rows.length, 3);
  assertEquals(changedCount(rows), 0);
});

Deno.test("pairLineDiff: flags exactly the masked lines with both versions", () => {
  const before = ["{", '  "lastName": "Weber",', '  "city": "Bern"', "}"].join("\n");
  const after = ["{", '  "lastName": "*eber",', '  "city": "Bern"', "}"].join("\n");
  const rows = pairLineDiff(before, after);
  assertEquals(changedCount(rows), 1);
  assertEquals(rows[1], {
    before: '  "lastName": "Weber",',
    after: '  "lastName": "*eber",',
    changed: true,
  });
  assertEquals(rows[2].changed, false);
});

Deno.test("pairLineDiff: a missing side becomes an empty string", () => {
  const rows = pairLineDiff("a\nb", "a");
  assertEquals(rows.length, 2);
  assertEquals(rows[1], { before: "b", after: "", changed: true });

  const grown = pairLineDiff("a", "a\nb");
  assertEquals(grown[1], { before: "", after: "b", changed: true });
});

Deno.test("pairLineDiff: empty texts pair to a single unchanged empty row", () => {
  assertEquals(pairLineDiff("", ""), [{ before: "", after: "", changed: false }]);
});

Deno.test("changedCount: counts changed rows only", () => {
  assertEquals(changedCount(pairLineDiff("a\nb\nc", "a\nX\nY")), 2);
});
