/**
 * Parity tests for the minimal xlsx reader. Run with `deno task test`.
 *
 * They read the committed fixture `src/testdata/vacation-mini.xlsx`, a
 * hand-assembled workbook that packs the reader-level edge cases into three
 * sheets: shared/inline/cached-formula strings, XML entities, unicode, a
 * rich-text run, an `xml:space="preserve"` trailing space, booleans, an error
 * cell, a style-only cell, a date serial, sparse rows, a wide `BC` reference,
 * a stored (uncompressed) zip entry and a workbook tab order that matches
 * neither rId order nor zip-entry order.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import { readWorkbook, refToRowCol } from "../static/availability/xlsx.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

function assertThrows(fn: () => unknown, includes: string): void {
  try {
    fn();
  } catch (err) {
    const text = String(err);
    if (!text.includes(includes)) {
      throw new Error(`error should mention "${includes}", got: ${text}`);
    }
    return;
  }
  throw new Error(`expected an error mentioning "${includes}"`);
}

async function assertRejects(fn: () => Promise<unknown>, includes: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const text = String(err);
    if (!text.includes(includes)) {
      throw new Error(`error should mention "${includes}", got: ${text}`);
    }
    return;
  }
  throw new Error(`expected a rejection mentioning "${includes}"`);
}

const FIXTURE = await Deno.readFile(new URL("./testdata/vacation-mini.xlsx", import.meta.url));
const SHEETS = await readWorkbook(FIXTURE);
const DATA = SHEETS[0].rows;

Deno.test("refToRowCol: decodes A1-style references, zero-based", () => {
  assertEquals(refToRowCol("A1"), { row: 0, col: 0 });
  assertEquals(refToRowCol("H1"), { row: 0, col: 7 });
  assertEquals(refToRowCol("BC12"), { row: 11, col: 54 });
  assertEquals(refToRowCol("AA101"), { row: 100, col: 26 });
});

Deno.test("refToRowCol: rejects anything that is not a cell reference", () => {
  assertThrows(() => refToRowCol("12A"), "invalid cell reference");
  assertThrows(() => refToRowCol("a1"), "invalid cell reference");
  assertThrows(() => refToRowCol(""), "invalid cell reference");
});

Deno.test("readWorkbook: sheets come back in workbook order, names unescaped", () => {
  assertEquals(
    SHEETS.map((s) => s.name),
    ["Data", "Legende & Übersicht", "Empty"],
  );
});

Deno.test("readWorkbook: shared, inline and cached-formula strings", () => {
  // A1 is a shared string from the stored (method-0) sharedStrings entry.
  assertEquals(DATA[0][0], "Team");
  assertEquals(DATA[0][1], "inline");
  assertEquals(DATA[0][5], "w", "t=str carries the formula's cached string");
});

Deno.test("readWorkbook: entities, unicode, rich-text runs and preserved spaces", () => {
  assertEquals(DATA[2][0], `A & B <x> "q" 'y'`);
  assertEquals(DATA[2][1], "rich", "rich-text runs concatenate");
  assertEquals(DATA[2][2], "keep ", "xml:space=preserve keeps the trailing space");
  assertEquals(DATA[4][54], "Đặng Tùng");
});

Deno.test("readWorkbook: numbers and date serials stay numbers", () => {
  assertEquals(DATA[0][2], 42.5);
  assertEquals(DATA[0][3], 45931, "date cells surface as raw serials");
  assertEquals(SHEETS[1].rows[1][1], -3.25);
});

Deno.test("readWorkbook: booleans, error cells and style-only cells", () => {
  assertEquals(DATA[0][4], true);
  assertEquals(DATA[2][3], false);
  assertEquals(DATA[0][6], null, "error cells read as null");
  assertEquals(DATA[0][7], null, "style-only cells read as null");
});

Deno.test("readWorkbook: sparse geometry — gap rows stay empty, wide refs land", () => {
  assertEquals(DATA.length, 5);
  assertEquals(DATA[1], [], "row 2 has no cells");
  assertEquals(DATA[3], [], "row 4 has no cells");
  assertEquals(DATA[4].length, 55, "row 5 is padded out to column BC");
  assertEquals(DATA[4][0], null);
});

Deno.test("readWorkbook: an empty sheet yields no rows", () => {
  assertEquals(SHEETS[2].rows, []);
});

Deno.test("readWorkbook: accepts an ArrayBuffer as well", async () => {
  const copy = FIXTURE.slice();
  const sheets = await readWorkbook(copy.buffer);
  assertEquals(sheets.map((s) => s.name), SHEETS.map((s) => s.name));
});

Deno.test("readWorkbook: rejects non-zip bytes with a clear error", async () => {
  const junk = new TextEncoder().encode("this is definitely not a spreadsheet, not even close");
  await assertRejects(() => readWorkbook(junk), "not a zip archive");
});

Deno.test("readWorkbook: rejects a truncated workbook with a clear error", async () => {
  await assertRejects(
    () => readWorkbook(FIXTURE.subarray(0, FIXTURE.byteLength - 40)),
    "not a zip archive",
  );
});

Deno.test("readWorkbook: rejects non-binary input outright", async () => {
  // deno-lint-ignore no-explicit-any
  await assertRejects(() => readWorkbook("nope" as any), "expects an ArrayBuffer or Uint8Array");
});
