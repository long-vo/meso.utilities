/**
 * Tests for the Compare Files diff/merge engine. Run with `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import {
  alignPair,
  alignTriple,
  buildHunks,
  charDiff,
  diffOps,
  diffStats,
  mergeRows,
  splitLines,
} from "../static/compare/compare.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

/* ------------------------------- splitLines ------------------------------- */

Deno.test("splitLines: normalises CRLF and CR line endings", () => {
  assertEquals(splitLines("a\r\nb\rc\nd"), ["a", "b", "c", "d"]);
});

/* --------------------------------- diffOps -------------------------------- */

Deno.test("diffOps: identical arrays are all same-ops", () => {
  assertEquals(diffOps(["a", "b"], ["a", "b"]), [
    { type: "same", value: "a" },
    { type: "same", value: "b" },
  ]);
});

Deno.test("diffOps: pure insertion and pure deletion", () => {
  assertEquals(diffOps([], ["x"]), [{ type: "add", value: "x" }]);
  assertEquals(diffOps(["x"], []), [{ type: "del", value: "x" }]);
});

Deno.test("diffOps: ops replay A into B (classic ABCABBA/CBABAC)", () => {
  const a = [..."ABCABBA"];
  const b = [..."CBABAC"];
  const ops = diffOps(a, b);
  // Replaying the script must reproduce both sides exactly.
  const left = ops.filter((op) => op.type !== "add").map((op) => op.value);
  const right = ops.filter((op) => op.type !== "del").map((op) => op.value);
  assertEquals(left, a);
  assertEquals(right, b);
  // Myers finds a shortest script: 5 edits for this pair.
  const edits = ops.filter((op) => op.type !== "same").length;
  assertEquals(edits, 5);
});

Deno.test("diffOps: common prefix and suffix stay untouched", () => {
  const ops = diffOps(["keep", "old", "keep2"], ["keep", "new", "keep2"]);
  assertEquals(ops[0], { type: "same", value: "keep" });
  assertEquals(ops[ops.length - 1], { type: "same", value: "keep2" });
});

/* -------------------------------- alignPair ------------------------------- */

Deno.test("alignPair: identical texts produce only same rows", () => {
  const rows = alignPair("a\nb", "a\nb");
  assertEquals(rows, [
    { a: "a", b: "a", type: "same" },
    { a: "b", b: "b", type: "same" },
  ]);
});

Deno.test("alignPair: a replaced line pairs into one mod row", () => {
  const rows = alignPair("a\nold\nc", "a\nnew\nc");
  assertEquals(rows, [
    { a: "a", b: "a", type: "same" },
    { a: "old", b: "new", type: "mod" },
    { a: "c", b: "c", type: "same" },
  ]);
});

Deno.test("alignPair: unpaired removals and additions keep their own rows", () => {
  const rows = alignPair("a\nx\ny\nc", "a\nc\nz");
  assertEquals(rows, [
    { a: "a", b: "a", type: "same" },
    { a: "x", b: null, type: "del" },
    { a: "y", b: null, type: "del" },
    { a: "c", b: "c", type: "same" },
    { a: null, b: "z", type: "add" },
  ]);
});

/* ------------------------------- alignTriple ------------------------------ */

Deno.test("alignTriple: all-equal texts are same rows", () => {
  const rows = alignTriple("a\nb", "a\nb", "a\nb");
  assertEquals(rows, [
    { a: "a", b: "a", c: "a", type: "same" },
    { a: "b", b: "b", c: "b", type: "same" },
  ]);
});

Deno.test("alignTriple: each side's private change lands in one diff row", () => {
  const rows = alignTriple("a\nA2\nc", "a\nb\nc", "a\nb\nC3");
  assertEquals(rows, [
    { a: "a", b: "a", c: "a", type: "same" },
    { a: "A2", b: "b", c: "b", type: "diff" },
    { a: "c", b: "c", c: "C3", type: "diff" },
  ]);
});

Deno.test("alignTriple: insertions unique to A or C get their own rows", () => {
  const rows = alignTriple("x\na", "a", "a\nz");
  assertEquals(rows, [
    { a: "x", b: null, c: null, type: "diff" },
    { a: "a", b: "a", c: "a", type: "same" },
    { a: null, b: null, c: "z", type: "diff" },
  ]);
});

/* -------------------------------- charDiff -------------------------------- */

Deno.test("charDiff: equal lines are one unchanged segment", () => {
  assertEquals(charDiff("same", "same"), {
    a: [{ text: "same", changed: false }],
    b: [{ text: "same", changed: false }],
  });
});

Deno.test("charDiff: segments concatenate back and mark the changed island", () => {
  const { a, b } = charDiff('  "name": "Weber",', '  "name": "****r",');
  assertEquals(a.map((s) => s.text).join(""), '  "name": "Weber",');
  assertEquals(b.map((s) => s.text).join(""), '  "name": "****r",');
  assertEquals(a.some((s) => s.changed), true);
  assertEquals(b.some((s) => s.changed), true);
  // The shared prefix stays unchanged on both sides.
  assertEquals(a[0].changed, false);
  assertEquals(b[0].changed, false);
});

Deno.test("charDiff: an empty side yields no segments for it", () => {
  const { a, b } = charDiff("", "added");
  assertEquals(a, []);
  assertEquals(b, [{ text: "added", changed: true }]);
});

/* ---------------------------- hunks and merging ---------------------------- */

Deno.test("buildHunks: groups consecutive changed rows, end exclusive", () => {
  const rows = alignPair("a\nx\ny\nc\nq", "a\nX\nY\nc\nr");
  assertEquals(buildHunks(rows), [
    { start: 1, end: 3 },
    { start: 4, end: 5 },
  ]);
});

Deno.test("buildHunks: no differences means no hunks", () => {
  assertEquals(buildHunks(alignPair("a", "a")), []);
});

Deno.test("mergeRows: picks choose sides per hunk, default keeps A", () => {
  const rows = alignPair("a\nfrom-a\nc\nalso-a", "a\nfrom-b\nc\nalso-b");
  const hunks = buildHunks(rows);
  assertEquals(mergeRows(rows, hunks, ["b", "a"]), "a\nfrom-b\nc\nalso-a");
  assertEquals(mergeRows(rows, hunks, []), "a\nfrom-a\nc\nalso-a");
});

Deno.test("mergeRows: picking the side without the line drops it", () => {
  const rows = alignPair("a\nextra\nc", "a\nc");
  const hunks = buildHunks(rows);
  assertEquals(mergeRows(rows, hunks, ["b"]), "a\nc");
  assertEquals(mergeRows(rows, hunks, ["a"]), "a\nextra\nc");
});

Deno.test("mergeRows: three-way picks can take any file's version", () => {
  const rows = alignTriple("a\nA\nz", "a\nB\nz", "a\nC\nz");
  const hunks = buildHunks(rows);
  assertEquals(hunks.length, 1);
  assertEquals(mergeRows(rows, hunks, ["c"]), "a\nC\nz");
  assertEquals(mergeRows(rows, hunks, ["b"]), "a\nB\nz");
});

/* -------------------------------- diffStats ------------------------------- */

Deno.test("diffStats: counts rows per type", () => {
  const stats = diffStats(alignPair("a\nx\nc", "a\ny\nc\nz"));
  assertEquals(stats.same, 2);
  assertEquals(stats.mod, 1);
  assertEquals(stats.add, 1);
  assertEquals(stats.del, 0);
});
