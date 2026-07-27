/**
 * Tests for the Sanitize tool's masked-log reading aids (line numbering, level
 * detection, filtering, search highlighting). Run with `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import {
  buildRows,
  detectLevel,
  filterRows,
  LEVELS,
  linesAligned,
  presentLevels,
  rowHtml,
} from "../static/logview.mjs";
import { runSanitizeLog } from "../static/sanitize.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

Deno.test("detectLevel: reads the level out of a line's prefix", () => {
  assertEquals(detectLevel("[2026-07-10 04:12:39.550][INFO ][runtimelog.baloise-id]{}"), "INFO");
  assertEquals(detectLevel("2026-07-10 04:12:40.100 ERROR request={}"), "ERROR");
  assertEquals(detectLevel("    id: a0884b97"), null);
});

Deno.test("detectLevel: folds aliases onto the canonical levels", () => {
  assertEquals(detectLevel("12:00 FATAL boom"), "ERROR");
  assertEquals(detectLevel("12:00 SEVERE boom"), "ERROR");
  assertEquals(detectLevel("12:00 WARNING careful"), "WARN");
  assertEquals(detectLevel("12:00 WARN careful"), "WARN");
});

Deno.test("detectLevel: prose is not a level", () => {
  // Lower-case, so it is a message rather than a level token.
  assertEquals(detectLevel("12:00 INFO the error was handled"), "INFO");
  assertEquals(detectLevel("12:00 something went wrong"), null);
});

Deno.test("detectLevel: an uppercase word deep in the message is ignored", () => {
  const line = `12:00 msg=${"x".repeat(250)} ERROR`;
  assertEquals(detectLevel(line), null);
});

Deno.test("buildRows: numbers lines from 1 and flags the masked ones", () => {
  const rows = buildRows("a\nsecret\nc", "a\n******\nc");
  assertEquals(rows.map((r) => r.n), [1, 2, 3]);
  assertEquals(rows.map((r) => r.changed), [false, true, false]);
  assertEquals(rows[1].before, "secret");
  assertEquals(rows[1].text, "******");
});

Deno.test("buildRows: a line with no level inherits the one above it", () => {
  const rows = buildRows(
    ["preamble", "12:00 ERROR class Foo {", "    id: 7", "12:00 INFO done"].join("\n"),
    ["preamble", "12:00 ERROR class Foo {", "    id: *", "12:00 INFO done"].join("\n"),
  );
  // The preamble precedes the first level token, so it belongs to no level.
  assertEquals(rows.map((r) => r.level), [null, "ERROR", "ERROR", "INFO"]);
});

Deno.test("presentLevels: only the levels the log uses, most severe first", () => {
  const text = ["12:00 INFO a", "12:00 ERROR b", "12:00 DEBUG c"].join("\n");
  assertEquals(presentLevels(buildRows(text, text)), ["ERROR", "INFO", "DEBUG"]);
  assertEquals(presentLevels(buildRows("plain", "plain")), []);
});

Deno.test("LEVELS: ordered most severe first", () => {
  assertEquals(LEVELS, ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"]);
});

Deno.test("filterRows: no options keeps every row", () => {
  const rows = buildRows("a\nb\nc", "a\nb\nc");
  const view = filterRows(rows);
  assertEquals(view.shown, 3);
  assertEquals(view.total, 3);
  assertEquals(view.matches, 0);
});

Deno.test("filterRows: a level filter keeps that level's lines and their body", () => {
  const text = [
    "12:00 ERROR class Foo {",
    "    id: 7",
    "}",
    "12:00 INFO fine",
  ].join("\n");
  const view = filterRows(buildRows(text, text), { levels: ["ERROR"] });
  assertEquals(view.rows.map((r) => r.n), [1, 2, 3]);
  assertEquals(view.total, 4);
});

Deno.test("filterRows: an empty or null level list means no level filtering", () => {
  const text = ["12:00 INFO a", "12:00 ERROR b"].join("\n");
  const rows = buildRows(text, text);
  assertEquals(filterRows(rows, { levels: [] }).shown, 2);
  assertEquals(filterRows(rows, { levels: null }).shown, 2);
});

Deno.test("filterRows: level-less lines drop out once a level filter is on", () => {
  const text = ["preamble", "12:00 INFO a"].join("\n");
  const view = filterRows(buildRows(text, text), { levels: ["INFO"] });
  assertEquals(view.rows.map((r) => r.n), [2]);
});

Deno.test("filterRows: onlyChanged keeps the lines masking touched", () => {
  const view = filterRows(buildRows("a\nsecret\nc", "a\n******\nc"), { onlyChanged: true });
  assertEquals(view.rows.map((r) => r.n), [2]);
  assertEquals(view.total, 3);
});

Deno.test("filterRows: the query highlights and counts but never hides a line", () => {
  const text = ["alpha", "beta", "alpha again"].join("\n");
  const view = filterRows(buildRows(text, text), { query: "alpha" });
  assertEquals(view.shown, 3, "search must not remove context around a hit");
  assertEquals(view.matches, 2);
  assertEquals(view.rows[0].hits, [{ start: 0, end: 5, index: 0 }]);
  assertEquals(view.rows[1].hits, []);
  assertEquals(view.rows[2].hits, [{ start: 0, end: 5, index: 1 }]);
});

Deno.test("filterRows: the query is case-insensitive and matches repeatedly", () => {
  const view = filterRows(buildRows("ab AB ab", "ab AB ab"), { query: "AB" });
  assertEquals(view.matches, 3);
  assertEquals(view.rows[0].hits.map((h) => h.start), [0, 3, 6]);
});

Deno.test("filterRows: the query is a substring, not a regex", () => {
  const view = filterRows(buildRows("a.c", "a.c"), { query: "a.c" });
  assertEquals(view.matches, 1);
  assertEquals(filterRows(buildRows("abc", "abc"), { query: "a.c" }).matches, 0);
});

Deno.test("filterRows: hit indices run across the visible rows only", () => {
  const text = ["12:00 INFO x", "12:00 ERROR x"].join("\n");
  const view = filterRows(buildRows(text, text), { levels: ["ERROR"], query: "x" });
  assertEquals(view.matches, 1);
  assertEquals(view.rows[0].hits[0].index, 0);
});

Deno.test("linesAligned: equal line counts pair, unequal ones do not", () => {
  assertEquals(linesAligned("a\nb", "a\nB"), true);
  assertEquals(linesAligned("a\nb", "a"), false);
  assertEquals(linesAligned("", ""), true);
});

Deno.test("linesAligned: a pretty-printed block survives masking aligned", () => {
  const log = ["12:00 INFO body={", '  "a": "secret"', "}", "12:01 INFO done"].join("\n");
  assertEquals(linesAligned(log, runSanitizeLog(log, { maskAll: true }).text), true);
});

Deno.test("linesAligned: a block masking re-flows is reported unaligned", () => {
  // An inline array is re-emitted one element per line, so the count grows and
  // the change flags must not be trusted.
  const log = ['body={\n  "xs": [1, 2]\n}'].join("\n");
  assertEquals(linesAligned(log, runSanitizeLog(log, { maskAll: true }).text), false);
});

Deno.test("rowHtml: escapes the line", () => {
  assertEquals(rowHtml('<a href="x">& more'), '&lt;a href="x"&gt;&amp; more');
});

Deno.test("rowHtml: tints masked runs", () => {
  assertEquals(
    rowHtml("id: ****7890 done"),
    'id: <span class="j-masked">****7890</span> done',
  );
});

Deno.test("rowHtml: a single asterisk is not a mask", () => {
  assertEquals(rowHtml("a * b"), "a * b");
});

Deno.test("rowHtml: marks search hits with their index", () => {
  assertEquals(
    rowHtml("find me", [{ start: 0, end: 4, index: 3 }]),
    '<span class="log-hit" data-hit="3">find</span> me',
  );
});

Deno.test("rowHtml: a hit inside a masked run splits into layered pieces", () => {
  const html = rowHtml("x ****ab y", [{ start: 6, end: 8, index: 0 }]);
  assertEquals(
    html,
    'x <span class="j-masked">****</span>' +
      '<span class="j-masked log-hit" data-hit="0">ab</span> y',
  );
});

Deno.test("rowHtml: offsets stay correct when escaping lengthens the text", () => {
  // "&" becomes "&amp;" — highlighting after escaping would land on the entity.
  assertEquals(
    rowHtml("&& target", [{ start: 3, end: 9, index: 0 }]),
    '&amp;&amp; <span class="log-hit" data-hit="0">target</span>',
  );
});
