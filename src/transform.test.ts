/**
 * Parity tests for the Text Transform tool. The browser UI
 * (static/transform/app.js) imports the same modules under test, so these
 * assertions are the contract the on-screen output must match.
 * Run with `deno task test`.
 */
import {
  ACTIONS,
  alignColumns,
  alignText,
  applyAction,
  capitalizeWords,
  CASE_FORMATS,
  CATEGORIES,
  cycleCase,
  filterActions,
  grepLines,
  groupByGrep,
  hierarchicalSort,
  invertCase,
  keepOnlyDuplicateLines,
  normalizeNewlines,
  parseFavorites,
  removeConsecutiveEmptyLines,
  reverseLetters,
  serializeFavorites,
  shiftQuotes,
  shuffleLines,
  sortJson,
  sortLines,
  sortLinesHex,
  sortTokens,
  splitWords,
  swapQuotes,
  switchPathSeparators,
  toCase,
  toggleCase,
  toggleFavorite,
  toSpringEnv,
} from "../static/transform/transform.mjs";
import { jsonToYaml, parseYaml, yamlToJson } from "../static/transform/yaml.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertThrows(fn: () => unknown, msg: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(msg);
}

/* ------------------------------ word splitting ---------------------------- */

Deno.test("splitWords: humps, acronyms, delimiters and digits", () => {
  assertEquals(splitWords("getUserAccountById"), ["get", "User", "Account", "By", "Id"]);
  assertEquals(splitWords("HTMLParser"), ["HTML", "Parser"]);
  assertEquals(splitWords("first-name_or.last name"), ["first", "name", "or", "last", "name"]);
  assertEquals(splitWords("user2Name"), ["user", "2", "Name"]);
  assertEquals(splitWords(""), []);
});

/* ------------------------------ case switching ---------------------------- */

Deno.test("toCase: every format from one phrase", () => {
  const input = "getUserAccount";
  const expected: Record<string, string> = {
    camel: "getUserAccount",
    kebab: "get-user-account",
    "kebab-upper": "GET-USER-ACCOUNT",
    snake: "get_user_account",
    "screaming-snake": "GET_USER_ACCOUNT",
    dot: "get.user.account",
    "words-lower": "get user account",
    sentence: "Get user account",
    title: "Get User Account",
    pascal: "GetUserAccount",
    "capitalized-snake": "Get_User_Account",
  };
  for (const format of CASE_FORMATS) {
    assertEquals(toCase(input, format.id), expected[format.id], `format ${format.id}`);
  }
});

Deno.test("toCase: works per line and keeps indentation", () => {
  assertEquals(
    toCase("  first-name\n\tlast-name\n", "camel"),
    "  firstName\n\tlastName\n",
  );
});

Deno.test("case detection: each format recognises its own output", () => {
  for (const format of CASE_FORMATS) {
    const sample = toCase("getUserAccount", format.id);
    assert(format.detect(sample), `${format.id} should detect "${sample}"`);
  }
});

Deno.test("cycleCase: steps through the format cycle", () => {
  assertEquals(cycleCase("getUserAccount"), "get-user-account"); // camel → kebab
  assertEquals(cycleCase("get-user-account"), "GET-USER-ACCOUNT"); // kebab → KEBAB
  assertEquals(cycleCase("GetUserAccount"), "getUserAccount"); // pascal → camel (wraps)
  assertEquals(cycleCase("hello"), "HELLO"); // no format matches → first changing format wins
});

Deno.test("toggleCase: flips between the two formats", () => {
  assertEquals(toggleCase("get_user", "snake", "camel"), "getUser");
  assertEquals(toggleCase("getUser", "snake", "camel"), "get_user");
  assertEquals(toggleCase("Get User", "title", "camel"), "getUser");
});

Deno.test("capitalizeWords: only first letters change", () => {
  assertEquals(capitalizeWords("hello brave new world"), "Hello Brave New World");
  assertEquals(capitalizeWords("keep MIXED case"), "Keep MIXED Case");
});

Deno.test("invertCase: swaps letter case, leaves the rest", () => {
  assertEquals(invertCase("Hello, World 42!"), "hELLO, wORLD 42!");
});

Deno.test("toSpringEnv: Spring Boot relaxed-binding form", () => {
  assertEquals(toSpringEnv("spring.main.log-startup-info"), "SPRING_MAIN_LOGSTARTUPINFO");
  assertEquals(toSpringEnv("my.service[0].other"), "MY_SERVICE_0_OTHER");
});

/* --------------------------------- sorting -------------------------------- */

Deno.test("sortLines: case-sensitive vs natural case-insensitive", () => {
  const input = "b\nB\na10\na2";
  assertEquals(sortLines(input), "B\na10\na2\nb");
  assertEquals(sortLines(input, { descending: true }), "b\na2\na10\nB");
  assertEquals(sortLines(input, { caseSensitive: false }), "a2\na10\nb\nB");
});

Deno.test("shuffleLines: deterministic with injected rng, keeps every line", () => {
  const input = "a\nb\nc\nd";
  const out = shuffleLines(input, () => 0);
  assertEquals(out.split("\n").sort().join("\n"), "a\nb\nc\nd");
  assertEquals(shuffleLines(input, () => 0), out, "same rng → same order");
});

Deno.test("sortLinesHex: by first hex number, no-hex lines last", () => {
  assertEquals(sortLinesHex("id 0xFF\nid 0x0A\nplain\nid 1F"), "id 0x0A\nid 1F\nid 0xFF\nplain");
});

Deno.test("sortTokens: within each line, natural order", () => {
  assertEquals(sortTokens("banana, apple, cherry", ","), "apple,banana,cherry");
  assertEquals(sortTokens("b10 b2 a", ""), "a b2 b10");
});

Deno.test("hierarchicalSort: sorts each level, children stay attached", () => {
  const input = ["b:", "  z", "  a", "a:", "  c", "  b"].join("\n");
  const expected = ["a:", "  b", "  c", "b:", "  a", "  z"].join("\n");
  assertEquals(hierarchicalSort(input), expected);
});

Deno.test("sortJson: object keys sorted recursively", () => {
  assertEquals(
    sortJson('{"b":1,"a":{"d":[{"y":1,"x":2}],"c":3}}'),
    JSON.stringify({ a: { c: 3, d: [{ x: 2, y: 1 }] }, b: 1 }, null, 2),
  );
});

/* --------------------------------- aligning ------------------------------- */

Deno.test("alignColumns: pads cells to the column width", () => {
  assertEquals(
    alignColumns("id,name,role\n1,amelia,admin\n42,bo,dev", ","),
    "id, name,   role\n1,  amelia, admin\n42, bo,     dev",
  );
});

Deno.test("alignText: center and right against the longest line", () => {
  assertEquals(alignText("abc\na", "right"), "abc\n  a");
  assertEquals(alignText("abcd\nab", "center"), "abcd\n ab");
  assertEquals(alignText("  abc  \na", "left"), "abc\na");
});

/* --------------------------- filter / remove / trim ----------------------- */

Deno.test("grepLines: substring, regex and inversion", () => {
  const input = "alpha\nbeta\ngamma";
  assertEquals(grepLines(input, "a"), "alpha\nbeta\ngamma");
  assertEquals(grepLines(input, "/^[ab]/"), "alpha\nbeta");
  assertEquals(grepLines(input, "/^[ab]/", { invert: true }), "gamma");
  assertEquals(grepLines(input, "/GAMMA/i"), "gamma");
  assertThrows(() => grepLines(input, ""), "empty pattern must throw");
});

Deno.test("groupByGrep: matches first, blank line between groups", () => {
  assertEquals(groupByGrep("a1\nb\na2", "a"), "a1\na2\n\nb");
  assertEquals(groupByGrep("a1\na2", "a"), "a1\na2", "no separator when everything matches");
});

Deno.test("duplicate handling: keep-only keeps one instance of repeats", () => {
  assertEquals(keepOnlyDuplicateLines("a\nb\na\nc\nb\na"), "a\nb");
  assertEquals(applyAction("remove-duplicates", "a\nb\na\nc"), "a\nb\nc");
});

Deno.test("whitespace and empty-line actions", () => {
  assertEquals(applyAction("trim", "  a  \n\tb\t"), "a\nb");
  assertEquals(applyAction("trim-trailing", "a  \n b "), "a\n b");
  assertEquals(applyAction("collapse-spaces", "a \t b\nc  d"), "a b\nc d");
  assertEquals(applyAction("remove-spaces", "a b\tc\nd e"), "abc\nde");
  assertEquals(applyAction("remove-empty", "a\n\n \nb"), "a\nb");
  assertEquals(removeConsecutiveEmptyLines("a\n\n\n\nb\n\nc"), "a\n\nb\n\nc");
  assertEquals(applyAction("remove-newlines", "a\r\nb\nc"), "abc");
});

/* ----------------------------- quotes & other ----------------------------- */

Deno.test("reverseLetters and swap-words work per line", () => {
  assertEquals(reverseLetters("abc\nde"), "cba\ned");
  assertEquals(applyAction("swap-words", "one two three\n  a b"), "three two one\n  b a");
});

Deno.test("shiftQuotes: double → single → backtick → double, re-escaped", () => {
  assertEquals(shiftQuotes('say "it\'s"'), "say 'it\\'s'");
  assertEquals(shiftQuotes("say 'hi'"), "say `hi`");
  assertEquals(shiftQuotes("say `hi`"), 'say "hi"');
});

Deno.test("swap / educate / straighten quotes", () => {
  assertEquals(swapQuotes(`"a" and 'b'`), `'a' and "b"`);
  assertEquals(
    applyAction("educate-quotes", `she said "hi" and it's fine`),
    "she said “hi” and it’s fine",
  );
  assertEquals(
    applyAction("straighten-quotes", "she said “hi” and it’s fine"),
    'she said "hi" and it\'s fine',
  );
});

Deno.test("switchPathSeparators: Windows ↔ UNIX", () => {
  assertEquals(switchPathSeparators("C:\\Users\\long\\file.txt"), "C:/Users/long/file.txt");
  assertEquals(switchPathSeparators("/home/long/file.txt"), "\\home\\long\\file.txt");
});

/* ------------------------------ JSON ↔ YAML ------------------------------- */

Deno.test("jsonToYaml: nested objects, arrays and quoting", () => {
  const json = JSON.stringify({
    name: "meso",
    version: "1.2",
    active: true,
    tags: ["a b", 7],
    nested: { list: [{ id: 1, label: "one" }], empty: [] },
  });
  assertEquals(
    jsonToYaml(json),
    [
      "name: meso",
      'version: "1.2"',
      "active: true",
      "tags:",
      "  - a b",
      "  - 7",
      "nested:",
      "  list:",
      "    - id: 1",
      "      label: one",
      "  empty: []",
    ].join("\n"),
  );
});

Deno.test("yamlToJson: block maps, sequences, flow, comments, scalars", () => {
  const yaml = [
    "# a comment",
    "---",
    "name: meso # trailing comment",
    "count: 42",
    "pi: 3.14",
    "ok: true",
    "nothing: null",
    'quoted: "a: b #c"',
    "flow: [1, two, {k: v}]",
    "list:",
    "  - one",
    "  - id: 2",
    "    label: two",
    "same-indent:",
    "- x",
    "- y",
  ].join("\n");
  assertEquals(parseYaml(yaml), {
    name: "meso",
    count: 42,
    pi: 3.14,
    ok: true,
    nothing: null,
    quoted: "a: b #c",
    flow: [1, "two", { k: "v" }],
    list: ["one", { id: 2, label: "two" }],
    "same-indent": ["x", "y"],
  });
});

Deno.test("YAML round trip: json → yaml → json is lossless", () => {
  const value = {
    service: { name: "leave-api", replicas: 3, debug: false },
    ports: [8080, 8443],
    labels: { "app.kubernetes.io/name": "leave", note: "hello world" },
    matrix: [["a", "b"], [1, 2]],
  };
  const yaml = jsonToYaml(JSON.stringify(value));
  assertEquals(JSON.parse(yamlToJson(yaml)), value);
});

Deno.test("yamlToJson: unsupported constructs throw descriptive errors", () => {
  assertThrows(() => yamlToJson("key: |\n  block"), "block scalars must throw");
  assertThrows(() => yamlToJson("key: &anchor v"), "anchors must throw");
});

/* ------------------------------ action registry --------------------------- */

Deno.test("ACTIONS: unique ids, known categories, all runnable", () => {
  const ids = new Set<string>();
  for (const action of ACTIONS) {
    assert(!ids.has(action.id), `duplicate action id ${action.id}`);
    ids.add(action.id);
    assert(CATEGORIES.includes(action.category), `unknown category ${action.category}`);
  }
  // every action runs without throwing on a harmless input (grep-style
  // actions get a pattern; shuffles get a fixed rng)
  for (const action of ACTIONS) {
    const input = action.id.startsWith("json") || action.id.startsWith("yaml")
      ? '{"b": 1, "a": 2}'
      : "alpha\nbeta";
    const out = applyAction(action.id, input, { pattern: "a", delimiter: ",", rng: () => 0.5 });
    assert(typeof out === "string", `${action.id} must return a string`);
  }
});

Deno.test("applyAction: normalizes CRLF and rejects unknown ids", () => {
  assertEquals(normalizeNewlines("a\r\nb\rc"), "a\nb\nc");
  assertEquals(applyAction("sort-az", "b\r\na"), "a\nb");
  assertThrows(() => applyAction("nope", "x"), "unknown id must throw");
});

Deno.test("favourites: parse tolerates junk, toggle keeps starred order", () => {
  assertEquals(parseFavorites(null), [], "no stored value → empty");
  assertEquals(parseFavorites("junk"), [], "unparseable → empty");
  assertEquals(parseFavorites('{"a":1}'), [], "non-array → empty");
  assertEquals(
    parseFavorites('["grep","no-such-action","grep",42,"trim"]'),
    ["grep", "trim"],
    "unknown ids, non-strings and duplicates are dropped",
  );
  assertEquals(toggleFavorite([], "grep"), ["grep"]);
  assertEquals(toggleFavorite(["grep", "trim"], "sort-az"), ["grep", "trim", "sort-az"]);
  assertEquals(toggleFavorite(["grep", "trim"], "grep"), ["trim"]);
  assertEquals(
    parseFavorites(serializeFavorites(["trim", "grep"])),
    ["trim", "grep"],
    "round trip keeps order",
  );
});

Deno.test("filterActions: every term must match label, category or keywords", () => {
  assert(filterActions("").length === ACTIONS.length, "empty query returns everything");
  const hits = filterActions("sort natural");
  assert(hits.length > 0 && hits.every((a) => a.category === "Sort lines"), "scoped to sorts");
  assertEquals(filterActions("yaml json").map((a) => a.id), ["json-to-yaml", "yaml-to-json"]);
  assertEquals(filterActions("zzz-no-such"), []);
});
