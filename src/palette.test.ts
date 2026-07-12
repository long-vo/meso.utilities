/**
 * Tests for the command-palette filtering/ranking. Run with `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import { filterCommands, scoreCommand } from "../static/palette.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

function assertGreater(a: number, b: number, msg?: string): void {
  if (!(a > b)) {
    throw new Error(`${msg ?? "assertGreater failed"}: expected ${a} > ${b}`);
  }
}

interface Command {
  title: string;
  keywords?: string[];
}

const decode: Command = { title: "Decode Anything", keywords: ["base64", "jwt"] };
const rest: Command = { title: "REST Client", keywords: ["http", "curl"] };
const sanitize: Command = { title: "Sanitize JSON", keywords: ["mask", "log"] };

Deno.test("scoreCommand: empty query matches everything neutrally", () => {
  assertEquals(scoreCommand(decode, ""), 0);
  assertEquals(scoreCommand(decode, "   "), 0);
});

Deno.test("scoreCommand: unrelated query does not match", () => {
  assertEquals(scoreCommand(decode, "spreadsheet"), -1);
});

Deno.test("scoreCommand: title substring outranks a keyword match", () => {
  const byTitle = scoreCommand(decode, "decode");
  const byKeyword = scoreCommand({ title: "Other", keywords: ["decode"] }, "decode");
  assertGreater(byTitle, byKeyword);
});

Deno.test("scoreCommand: earlier title match ranks higher", () => {
  assertGreater(scoreCommand(decode, "decode"), scoreCommand(decode, "anything"));
});

Deno.test("scoreCommand: keyword match works and is case-insensitive", () => {
  assertGreater(scoreCommand(decode, "JWT"), 0);
});

Deno.test("scoreCommand: every query word must match somewhere", () => {
  assertGreater(scoreCommand(rest, "rest curl"), 0);
  assertEquals(scoreCommand(rest, "rest xyz"), -1);
});

Deno.test("scoreCommand: falls back to an in-order title subsequence", () => {
  // "sjson" is not a substring or keyword of "Sanitize JSON", but its letters
  // appear in order.
  assertGreater(scoreCommand(sanitize, "sjson"), 0);
  assertEquals(scoreCommand(sanitize, "zzsan"), -1, "out-of-order letters do not match");
});

Deno.test("filterCommands: empty query keeps registration order", () => {
  assertEquals(filterCommands([decode, rest, sanitize], ""), [decode, rest, sanitize]);
});

Deno.test("filterCommands: filters non-matches and ranks best first", () => {
  const commands = [rest, { title: "Other", keywords: ["decode"] }, decode];
  assertEquals(filterCommands(commands, "decode"), [
    decode,
    { title: "Other", keywords: ["decode"] },
  ]);
});
