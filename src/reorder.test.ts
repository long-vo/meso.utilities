/**
 * Parity tests for the hub's card-ordering logic (static/reorder.mjs) — the
 * same module the browser imports, so what's asserted here is what ships. The
 * DOM/pointer wiring lives in hub.js and is exercised in the browser only.
 * Dependency-free (no remote std import) so it runs offline, like its siblings.
 */
import {
  insertionIndex,
  moveBy,
  moveItem,
  ORDER_KEY,
  parseOrder,
  reconcileOrder,
  withVisibleOrder,
} from "../static/reorder.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

/** A row of three 100×80 cards at y=0, then a second row at y=100. */
function grid() {
  return [
    { left: 0, top: 0, width: 100, height: 80 },
    { left: 120, top: 0, width: 100, height: 80 },
    { left: 240, top: 0, width: 100, height: 80 },
    { left: 0, top: 100, width: 100, height: 80 },
  ];
}

Deno.test("ORDER_KEY is the documented localStorage key", () => {
  assertEquals(ORDER_KEY, "meso-tool-order");
});

Deno.test("parseOrder: reads a stored list of ids", () => {
  assertEquals(parseOrder('["a","b"]'), ["a", "b"]);
});

Deno.test("parseOrder: missing, corrupt or wrongly-shaped values yield no order", () => {
  assertEquals(parseOrder(null), []);
  assertEquals(parseOrder("not json"), []);
  assertEquals(parseOrder('{"a":1}'), []);
});

Deno.test("parseOrder: drops non-strings and duplicates", () => {
  assertEquals(parseOrder('["a",1,"b",null,"a"]'), ["a", "b"]);
});

Deno.test("reconcileOrder: saved order wins for ids that still exist", () => {
  assertEquals(reconcileOrder(["c", "a"], ["a", "b", "c"]), ["c", "a", "b"]);
});

Deno.test("reconcileOrder: ids that no longer exist are dropped", () => {
  assertEquals(reconcileOrder(["gone", "b"], ["a", "b"]), ["b", "a"]);
});

Deno.test("reconcileOrder: a newly added tool is appended, not lost", () => {
  assertEquals(reconcileOrder(["b", "a"], ["a", "b", "new"]), ["b", "a", "new"]);
});

Deno.test("reconcileOrder: no saved order keeps the authored order", () => {
  assertEquals(reconcileOrder([], ["a", "b", "c"]), ["a", "b", "c"]);
  assertEquals(reconcileOrder(undefined, ["a", "b"]), ["a", "b"]);
});

Deno.test("reconcileOrder: duplicate ids on the page are kept once", () => {
  assertEquals(reconcileOrder(["b"], ["a", "b", "a"]), ["b", "a"]);
});

Deno.test("withVisibleOrder: hidden ids keep their slots", () => {
  // "h" is filtered out; the two visible cards swap around it.
  assertEquals(withVisibleOrder(["a", "h", "b"], ["b", "a"]), ["b", "h", "a"]);
});

Deno.test("withVisibleOrder: everything visible is just the new order", () => {
  assertEquals(withVisibleOrder(["a", "b", "c"], ["c", "b", "a"]), ["c", "b", "a"]);
});

Deno.test("withVisibleOrder: a hidden card at either end stays put", () => {
  assertEquals(withVisibleOrder(["h", "a", "b"], ["b", "a"]), ["h", "b", "a"]);
  assertEquals(withVisibleOrder(["a", "b", "h"], ["b", "a"]), ["b", "a", "h"]);
});

Deno.test("moveItem: moving forwards accounts for the removed slot", () => {
  // "a" dropped before index 3 lands last, not second-to-last.
  assertEquals(moveItem(["a", "b", "c"], 0, 3), ["b", "c", "a"]);
  assertEquals(moveItem(["a", "b", "c"], 0, 2), ["b", "a", "c"]);
});

Deno.test("moveItem: moving backwards inserts at the target index", () => {
  assertEquals(moveItem(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
  assertEquals(moveItem(["a", "b", "c"], 2, 1), ["a", "c", "b"]);
});

Deno.test("moveItem: dropping an item on its own slot changes nothing", () => {
  assertEquals(moveItem(["a", "b", "c"], 1, 1), ["a", "b", "c"]);
  assertEquals(moveItem(["a", "b", "c"], 1, 2), ["a", "b", "c"]);
});

Deno.test("moveItem: clamps out-of-range targets and ignores bad sources", () => {
  assertEquals(moveItem(["a", "b"], 0, 99), ["b", "a"]);
  assertEquals(moveItem(["a", "b"], 1, -5), ["b", "a"]);
  assertEquals(moveItem(["a", "b"], 7, 0), ["a", "b"]);
});

Deno.test("moveItem: a target that isn't a number moves nothing", () => {
  // NaN would otherwise fall through splice() as index 0 and move the item.
  assertEquals(moveItem(["a", "b", "c"], 2, NaN), ["a", "b", "c"]);
  assertEquals(moveItem(["a", "b", "c"], 2, undefined), ["a", "b", "c"]);
});

Deno.test("moveBy: steps an id one slot in either direction", () => {
  assertEquals(moveBy(["a", "b", "c"], "a", 1), ["b", "a", "c"]);
  assertEquals(moveBy(["a", "b", "c"], "c", -1), ["a", "c", "b"]);
});

Deno.test("moveBy: a row jump moves by the column count", () => {
  assertEquals(moveBy(["a", "b", "c", "d"], "a", 3), ["b", "c", "d", "a"]);
  assertEquals(moveBy(["a", "b", "c", "d"], "d", -3), ["d", "a", "b", "c"]);
});

Deno.test("moveBy: overshooting an edge clamps to it", () => {
  assertEquals(moveBy(["a", "b", "c"], "b", 9), ["a", "c", "b"]);
  assertEquals(moveBy(["a", "b", "c"], "b", -9), ["b", "a", "c"]);
});

Deno.test("moveBy: at the edge, or with an unknown id, nothing moves", () => {
  assertEquals(moveBy(["a", "b"], "a", -1), ["a", "b"]);
  assertEquals(moveBy(["a", "b"], "b", 1), ["a", "b"]);
  assertEquals(moveBy(["a", "b"], "zzz", 1), ["a", "b"]);
  assertEquals(moveBy(["a", "b"], "a", 0), ["a", "b"]);
});

Deno.test("insertionIndex: the left half of a card inserts before it", () => {
  assertEquals(insertionIndex(grid(), { x: 130, y: 40 }), 1);
});

Deno.test("insertionIndex: the right half of a card inserts after it", () => {
  assertEquals(insertionIndex(grid(), { x: 210, y: 40 }), 2);
});

Deno.test("insertionIndex: the empty tail of the last row appends", () => {
  // The row above is closer as the crow flies; the pointer's own row wins.
  assertEquals(insertionIndex(grid(), { x: 200, y: 140 }), 4);
  assertEquals(insertionIndex(grid(), { x: 400, y: 140 }), 4);
});

Deno.test("insertionIndex: before the first card yields 0", () => {
  assertEquals(insertionIndex(grid(), { x: -50, y: 10 }), 0);
});

Deno.test("insertionIndex: the nearest centre wins across rows", () => {
  // Below the first row but nearest the second-row card: insert before it.
  assertEquals(insertionIndex(grid(), { x: 20, y: 120 }), 3);
});

Deno.test("insertionIndex: dragging below the grid appends", () => {
  // Nothing shares the pointer's row, and the last row must win over the
  // column that happens to be closest as the crow flies.
  assertEquals(insertionIndex(grid(), { x: 20, y: 400 }), 4);
  assertEquals(insertionIndex(grid(), { x: 400, y: 400 }), 4);
});

Deno.test("insertionIndex: in the gutter, the row above claims the pointer", () => {
  assertEquals(insertionIndex(grid(), { x: 20, y: 90 }), 1);
  assertEquals(insertionIndex(grid(), { x: 300, y: 90 }), 3);
});

Deno.test("insertionIndex: above the whole grid inserts first", () => {
  assertEquals(insertionIndex(grid(), { x: 60, y: -80 }), 0);
});

Deno.test("insertionIndex: an empty grid inserts at 0", () => {
  assertEquals(insertionIndex([], { x: 10, y: 10 }), 0);
});

/** A narrow screen collapses the grid to one column: three stacked cards. */
function column() {
  return [
    { left: 0, top: 0, width: 100, height: 80 },
    { left: 0, top: 100, width: 100, height: 80 },
    { left: 0, top: 200, width: 100, height: 80 },
  ];
}

Deno.test("insertionIndex: one column decides by the vertical midpoint", () => {
  assertEquals(insertionIndex(column(), { x: 50, y: 120 }), 1); // top half of card 2
  assertEquals(insertionIndex(column(), { x: 50, y: 170 }), 2); // bottom half of card 2
});

Deno.test("insertionIndex: one column, above the first and below the last", () => {
  assertEquals(insertionIndex(column(), { x: 50, y: 5 }), 0);
  assertEquals(insertionIndex(column(), { x: 50, y: 500 }), 3);
});

Deno.test("insertionIndex: dead centre of a card counts as before it", () => {
  // A touch drag lands dead centre often; it must not read as "past" the card.
  assertEquals(insertionIndex(column(), { x: 50, y: 140 }), 1);
  assertEquals(insertionIndex(grid(), { x: 170, y: 40 }), 1);
});
