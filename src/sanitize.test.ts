/**
 * Parity tests: assert the ported logic masks exactly like the original
 * `/sanitize-text` Slack command. Run with `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import { maskString, runSanitize, sanitize } from "./sanitize.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

function fieldSet(...names: string[]): Set<string> {
  return new Set(names.map((n) => n.toLowerCase()));
}

Deno.test("maskString: keepLast <= 0 masks the whole string", () => {
  assertEquals(maskString("hello", 0), "*****");
  assertEquals(maskString("hello", -3), "*****");
});

Deno.test("maskString: short secret (len <= keepLast) is fully masked", () => {
  assertEquals(maskString("ab", 4), "**");
  assertEquals(maskString("1234", 4), "****");
});

Deno.test("maskString: reveals only the last N characters", () => {
  assertEquals(maskString("secret123", 4), "*****t123");
  assertEquals(maskString("weber", 2), "***er");
});

Deno.test("sanitize: matches keys case-insensitively at any depth", () => {
  const input = {
    person: { LastName: "Weber", first: "Jara" },
    contacts: [{ email: "a@b.com" }, { email: "c@d.com" }],
  };
  const out = sanitize(input, fieldSet("lastname", "email"), 2);
  assertEquals(out, {
    person: { LastName: "***er", first: "Jara" },
    contacts: [{ email: "*****om" }, { email: "*****om" }],
  });
});

Deno.test("sanitize: numbers are masked as strings", () => {
  const out = sanitize({ pin: 12345 }, fieldSet("pin"), 2);
  assertEquals(out, { pin: "***45" });
});

Deno.test("sanitize: booleans and null under a matched key pass through", () => {
  const out = sanitize({ active: true, deleted: null }, fieldSet("active", "deleted"), 0);
  assertEquals(out, { active: true, deleted: null });
});

Deno.test("sanitize: a matched container masks every leaf inside it", () => {
  const out = sanitize(
    { user: { email: "a@b.com", name: "X", age: 40, ok: true } },
    fieldSet("user"),
    0,
  );
  assertEquals(out, { user: { email: "*******", name: "*", age: "**", ok: true } });
});

Deno.test("sanitize: arrays under a matched key are masked element-wise", () => {
  const out = sanitize({ tokens: ["abcd", "efgh"] }, fieldSet("tokens"), 0);
  assertEquals(out, { tokens: ["****", "****"] });
});

Deno.test("runSanitize: parses free-form fields and reports stats", () => {
  const result = runSanitize(
    '{"a":{"email":"a@b.com"},"b":{"email":"c@d.com"},"x":1}',
    "email, missingField",
    4,
  );
  if (!result.ok) throw new Error("expected ok result");
  assertEquals(result.stats.maskedValues, 2);
  assertEquals(result.stats.matchedKeys, ["email"]);
  assertEquals(result.stats.fieldCount, 2);
  assertEquals(result.fields, ["email", "missingField"]);
});

Deno.test("runSanitize: invalid JSON returns a failure with a message", () => {
  const result = runSanitize("{ not json", "email", 4);
  assertEquals(result.ok, false);
  if (result.ok) throw new Error("expected failure");
  if (typeof result.error !== "string" || result.error.length === 0) {
    throw new Error("expected a non-empty error message");
  }
});

Deno.test("runSanitize: array field list is accepted", () => {
  const result = runSanitize('{"email":"a@b.com"}', ["email"], 0);
  if (!result.ok) throw new Error("expected ok result");
  assertEquals(result.sanitized, { email: "*******" });
});
